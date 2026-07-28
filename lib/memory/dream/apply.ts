/**
 * Apply Dream operations to the memory store.
 *
 * Executes the sanitized operation list from phase3. Each operation type
 * maps to a concrete DAL mutation. Failures are isolated — one bad op
 * does not abort the whole run.
 *
 * Provenance note: until the `dream_meta` jsonb column lands (planned
 * Phase 2 follow-up), provenance is recorded in the `dream_runs` audit
 * row at the run level, not per-memory. The per-memory `dream_meta`
 * enrichment is layered in once the migration exists.
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/apply.py.
 */

import {
  deleteLongTermMemoryRow,
  upsertLongTermMemoryByKey,
} from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

import type { DreamOperation } from './types';

const logger = createLogger('memory.dream.apply');

export interface ApplyResult {
  applied: number;
  skipped: number;
  failed: number;
  /** IDs written by CONSOLIDATE/PROPOSE, used by SUPERSEDE resolution. */
  writtenMemoryIds: string[];
}

/**
 * Apply a sanitized batch of Dream operations for one user.
 *
 * IMPORTANT ordering rule: SUPERSEDE ops are resolved by *memory id*,
 * not by array order, so callers do not need to pre-sort. CONSOLIDATE
 * must run before the SUPERSEDE that points at its output — the
 * orchestrator naturally produces them in that order.
 *
 * `config` is required for PROPOSE (embedding index) but optional for
 * DELETE / SUPERSEDE.
 */
export async function applyDreamOperations(input: {
  userId: string;
  operations: DreamOperation[];
  config?: AppConfig;
}): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  const writtenMemoryIds: string[] = [];

  for (const op of input.operations) {
    try {
      switch (op.type) {
        case 'CONSOLIDATE': {
          // Upsert the canonical fact by (userId, key) within the source
          // project scope. Reuses the extractor's upsert path so the row
          // gets embedding-indexed + recall-cache-invalidated the same way.
          const { row } = await upsertLongTermMemoryByKey({
            userId: input.userId,
            key: op.mergedKey,
            content: op.mergedContent,
            memoryType: op.mergedType,
            importance: op.mergedImportance,
            projectId: op.projectId ?? null,
          });
          writtenMemoryIds.push(row.id);
          // P0: delete the source memories (matches compact.ts behavior).
          // TODO(Phase 2): once `long_term_memories.dream_meta` lands,
          // switch this to a soft-supersede (set status='superseded') so
          // the originals survive for audit / ratification review.
          // Provenance is currently captured at the dream_runs audit row.
          await Promise.all(
            op.sourceMemoryIds.map((id) =>
              deleteLongTermMemoryRow(id, { userId: input.userId }).catch(
                () => {
                  /* source may already be gone — non-fatal */
                },
              ),
            ),
          );
          applied += 1;
          break;
        }

        case 'PROPOSE': {
          // Phase 2 only. Writes a tentative memory — until dream_meta
          // exists, this lands as a normal row with a special key prefix
          // so recall can filter it out until ratified.
          const tentativeKey = `dream.proposal.${op.key}`;
          const { row } = await upsertLongTermMemoryByKey({
            userId: input.userId,
            key: tentativeKey,
            content: op.content,
            memoryType: op.memoryType,
            importance: op.importance,
            projectId: op.projectId ?? null,
          });
          writtenMemoryIds.push(row.id);
          applied += 1;
          break;
        }

        case 'DELETE': {
          let deletedHere = 0;
          for (const id of op.memoryIds) {
            const ok = await deleteLongTermMemoryRow(id, {
              userId: input.userId,
            }).catch(() => null);
            if (ok) deletedHere += 1;
          }
          applied += deletedHere > 0 ? 1 : 0;
          skipped += op.memoryIds.length - deletedHere;
          break;
        }

        case 'SUPERSEDE': {
          // P0: delete the superseded row. Provenance (oldMemoryId →
          // newMemoryId mapping) is captured in the dream_runs audit row.
          // TODO(Phase 2): flip to soft-supersede via dream_meta.status.
          const ok = await deleteLongTermMemoryRow(op.oldMemoryId, {
            userId: input.userId,
          }).catch(() => null);
          if (ok) {
            applied += 1;
          } else {
            skipped += 1;
          }
          break;
        }

        default: {
          // Exhaustiveness check — unknown op types are a programming error.
          skipped += 1;
        }
      }
    } catch (error) {
      failed += 1;
      logger.warn('apply:op_failed', {
        type: op.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('apply:done', {
    userId: input.userId,
    totalOps: input.operations.length,
    applied,
    skipped,
    failed,
  });

  return { applied, skipped, failed, writtenMemoryIds };
}
