/**
 * Apply Dream operations to the memory store.
 *
 * Executes the sanitized operation list from phase3. Each operation type
 * maps to a concrete DAL mutation. Failures are isolated — one bad op
 * does not abort the whole run.
 *
 * Provenance is written per row through `dream_meta`:
 *  - `dream_meta.provenance.dreamRunId` traces every written / superseded
 *    row back to the run that produced it.
 *  - `dream_meta.provenance.sourceMemoryIds` records which source rows a
 *    consolidated fact was derived from.
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/apply.py.
 */

import {
  adjustLongTermMemoryImportance,
  deleteLongTermMemoryRow,
  getLongTermMemoryPreimages,
  markLongTermMemorySuperseded,
  upsertLongTermMemoryByKey,
} from '@/lib/core/db/memory/long-term';
import {
  invalidateMemoryCaches,
  scheduleReindex,
} from '@/lib/memory/cache-invalidation';
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
  /**
   * Pre-images of rows hard-deleted by DELETE ops (OpenClaw stores
   * rewrite preimages before an accepted rewrite). Recorded in the
   * dream_runs audit row so a destructive Dream pass stays reviewable
   * and manually recoverable. Capped — see MAX_DELETE_PREIMAGES.
   */
  deletePreimages: Array<{
    id: string;
    key: string | null;
    content: string;
    memoryType: string;
    importance: number;
    projectId: string;
  }>;
}

/** Cap on pre-images kept per run so the audit row stays bounded. */
const MAX_DELETE_PREIMAGES = 50;

/**
 * Apply a sanitized batch of Dream operations for one user.
 *
 * IMPORTANT ordering rule: SUPERSEDE ops are resolved by *memory id*,
 * not by array order, so callers do not need to pre-sort. CONSOLIDATE
 * must run before the SUPERSEDE that points at its output — the
 * orchestrator naturally produces them in that order.
 *
 * @param input.runId  Required. The Dream run id, written into every
 *   row's `dream_meta.provenance.dreamRunId` so each mutation traces
 *   back to the run that produced it.
 */
export async function applyDreamOperations(input: {
  userId: string;
  /**
   * Dream run id, propagated into every written/superseded row's
   * provenance. Required for run-level traceability.
   */
  runId: string;
  operations: DreamOperation[];
  config?: AppConfig;
}): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  const writtenMemoryIds: string[] = [];
  const deletePreimages: ApplyResult['deletePreimages'] = [];

  for (const op of input.operations) {
    try {
      switch (op.type) {
        case 'CONSOLIDATE': {
          // Upsert the canonical fact by (userId, key) within the source
          // project scope. Marked active + dreamMeta records provenance
          // (source ids + dream run id) so the canonical fact can be
          // traced back to the memories it consolidated.
          const { row } = await upsertLongTermMemoryByKey({
            userId: input.userId,
            key: op.mergedKey,
            content: op.mergedContent,
            memoryType: op.mergedType,
            importance: op.mergedImportance,
            projectId: op.projectId ?? null,
            dreamStatus: 'active',
            dreamMeta: {
              confidence: op.confidence,
              sourceKind: 'dream_consolidated',
              provenance: {
                sourceMemoryIds: op.sourceMemoryIds,
                dreamRunId: input.runId,
              },
              lastDreamAt: new Date().toISOString(),
            },
          });
          writtenMemoryIds.push(row.id);
          scheduleReindex(row.id, input.config);
          // Soft-supersede the sources: flip dream_status to 'superseded'
          // rather than deleting, so the originals survive for audit /
          // provenance review. Recall excludes superseded rows via the
          // partial index on dream_status='active'. Skip any source id
          // that equals the newly-written row (an upsert by key can
          // return the SAME row when the canonical fact already existed
          // — superseding it would mark the survivor retired).
          await Promise.all(
            op.sourceMemoryIds.map((id) =>
              id === row.id
                ? Promise.resolve()
                : markLongTermMemorySuperseded({
                    id,
                    userId: input.userId,
                    supersededBy: row.id,
                    dreamRunId: input.runId,
                  }).catch(() => {
                    /* source may already be gone — non-fatal */
                  }),
            ),
          );
          applied += 1;
          break;
        }

        case 'PROPOSE': {
          // Phase 2 only. Writes a TENTATIVE memory: dream_status=
          // 'tentative' excludes it from recall until ratified. The key
          // still uses the 'dream.proposal.*' prefix for back-compat with
          // any code that predates the dream_status column, but the
          // partial index on dream_status='active' is what actually gates
          // recall now.
          const tentativeKey = `dream.proposal.${op.key}`;
          const { row } = await upsertLongTermMemoryByKey({
            userId: input.userId,
            key: tentativeKey,
            content: op.content,
            memoryType: op.memoryType,
            importance: op.importance,
            projectId: op.projectId ?? null,
            dreamStatus: 'tentative',
            dreamMeta: {
              confidence: op.confidence,
              sourceKind: 'dream_recombined',
              provenance: {
                sourceMemoryIds: op.fromMemoryIds,
                dreamRunId: input.runId,
              },
              rationale: op.rationale,
              lastDreamAt: new Date().toISOString(),
            },
          });
          writtenMemoryIds.push(row.id);
          scheduleReindex(row.id, input.config);
          applied += 1;
          break;
        }

        case 'DELETE': {
          // Capture pre-images BEFORE deleting so the run audit keeps a
          // recoverable record of what was destroyed (OpenClaw preimage
          // discipline). Bounded by MAX_DELETE_PREIMAGES.
          if (deletePreimages.length < MAX_DELETE_PREIMAGES) {
            const preimages = await getLongTermMemoryPreimages(
              op.memoryIds,
              input.userId,
            ).catch((error) => {
              // Deletion must proceed even when the audit preimage cannot
              // be captured — but the gap must be visible in the logs.
              logger.warn('apply:preimage_failed', {
                userId: input.userId,
                memoryIds: op.memoryIds,
                error: error instanceof Error ? error.message : String(error),
              });
              return [];
            });
            for (const preimage of preimages) {
              if (deletePreimages.length >= MAX_DELETE_PREIMAGES) break;
              deletePreimages.push(preimage);
            }
          }
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

        case 'ADJUST_IMPORTANCE': {
          // Deterministic usage-feedback adjustment: single ±1 step,
          // reason + run id recorded in dream_meta for audit.
          const ok = await adjustLongTermMemoryImportance({
            id: op.memoryId,
            userId: input.userId,
            importance: op.importance,
            reason: op.reason,
            dreamRunId: input.runId,
          }).catch(() => null);
          if (ok) {
            applied += 1;
          } else {
            skipped += 1;
          }
          break;
        }

        case 'SUPERSEDE': {
          // Soft-supersede: flip dream_status, keep the row for audit.
          // Provenance (oldMemoryId → newMemoryId mapping + run id) is
          // recorded in dream_meta.provenance on the retired row.
          const ok = await markLongTermMemorySuperseded({
            id: op.oldMemoryId,
            userId: input.userId,
            supersededBy: op.newMemoryId,
            dreamRunId: input.runId,
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
        // Per-op identifying fields vary by type; surface whichever this
        // op carries so two failures of the same type within one run can
        // be told apart in the logs.
        opKey:
          op.type === 'CONSOLIDATE'
            ? op.mergedKey
            : op.type === 'PROPOSE'
              ? op.key
              : undefined,
        opIds:
          op.type === 'CONSOLIDATE'
            ? op.sourceMemoryIds
            : op.type === 'PROPOSE'
              ? op.fromMemoryIds
              : op.type === 'DELETE'
                ? op.memoryIds
                : op.type === 'SUPERSEDE'
                  ? [op.oldMemoryId, op.newMemoryId]
                  : op.type === 'ADJUST_IMPORTANCE'
                    ? [op.memoryId]
                    : undefined,
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

  // Phase 3:不管本次 apply 是否修改了记忆,统一失效缓存 + bump version。
  // 修复一个历史隐患(dream 写后 recall/trigger/profile cache 不失效),同时
  // 保证 ContextPacker cache(含 memoryVersion)在 dream 运行后失效。
  // 见 phase1-review #1 + docs/memory-provider-unification-plan.md §1.5。
  //
  // reviewer phase3 S1:条件收窄为 applied>0。failed>0 表示 op 抛错没写成功,
  // 不应 bump(写没成功却假装变了,与 write-gate 语义矛盾)。
  if (applied > 0) {
    await invalidateMemoryCaches(input.userId);
  }

  return { applied, skipped, failed, writtenMemoryIds, deletePreimages };
}
