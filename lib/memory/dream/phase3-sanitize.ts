/**
 * Phase 3 — Sanitize.
 *
 * Filters the operations proposed by Phase 1/2 BEFORE they reach apply.ts.
 * This is the last line of defense before writes hit the DB, so it is
 * intentionally cheap (no LLM) and deterministic.
 *
 * Checks:
 *  1. Near-duplicate collapse on PROPOSE / CONSOLIDATE outputs — if two
 *     operations would write near-identical contents, keep the first and
 *     drop the rest (mirrors AutoGPT's `_dedupe_near_duplicate_writes`).
 *  2. Self-supersede guard — never SUPERSEDE a memory that another op in
 *     the same batch already superseded (would double-debit).
 *  3. Cross-op dedupe — a CONSOLIDATE whose merged content near-duplicates
 *     a PROPOSE in the same batch collapses to a single write.
 *
 * AutoGPT analogue: ref/.../backend/copilot/dream/orchestrator.py
 * ::_run_sanitize + `_clamp_operations`.
 */

import { createLogger } from '@/lib/utils/logger';

import { isNearDuplicate } from './bigram';
import type { DreamOperation } from './types';

const logger = createLogger('memory.dream.phase3');

/**
 * Content-bearing operations we dedupe on. DELETE / SUPERSEDE have no
 * "content" of their own — they only reference other rows.
 */
function operationContent(op: DreamOperation): string | null {
  switch (op.type) {
    case 'CONSOLIDATE':
      return op.mergedContent;
    case 'PROPOSE':
      return op.content;
    default:
      return null;
  }
}

/**
 * Sanitize a batch of operations. Returns the filtered list + stats.
 *
 * The order of the input is preserved — "first writer wins" so callers
 * should pass higher-confidence / earlier-phase operations first.
 */
export function sanitizeOperations(operations: DreamOperation[]): {
  accepted: DreamOperation[];
  rejectedDuplicates: number;
} {
  const accepted: DreamOperation[] = [];
  const supersededIds = new Set<string>();
  let rejectedDuplicates = 0;

  for (const op of operations) {
    // SUPERSEDE guard: skip if the source was already superseded in this batch.
    if (op.type === 'SUPERSEDE') {
      if (supersededIds.has(op.oldMemoryId)) {
        rejectedDuplicates += 1;
        continue;
      }
      supersededIds.add(op.oldMemoryId);
      accepted.push(op);
      continue;
    }

    // DELETE guard: skip deleting something already superseded.
    if (op.type === 'DELETE') {
      const survivors = op.memoryIds.filter((id) => !supersededIds.has(id));
      if (survivors.length === 0) {
        rejectedDuplicates += op.memoryIds.length;
        continue;
      }
      if (survivors.length < op.memoryIds.length) {
        rejectedDuplicates += op.memoryIds.length - survivors.length;
      }
      for (const id of survivors) supersededIds.add(id);
      accepted.push({ ...op, memoryIds: survivors });
      continue;
    }

    // CONSOLIDATE / PROPOSE: near-duplicate content check against already
    // accepted writes. Also mark source ids as superseded so later DELETE /
    // SUPERSEDE ops don't double-count.
    const content = operationContent(op);
    if (content !== null) {
      const dupOf = accepted.find((acc) => {
        const accContent = operationContent(acc);
        return accContent !== null && isNearDuplicate(content, accContent);
      });
      if (dupOf) {
        rejectedDuplicates += 1;
        logger.info('phase3:rejected_near_duplicate', {
          type: op.type,
          duplicateOfType: dupOf.type,
        });
        continue;
      }
    }

    if (op.type === 'CONSOLIDATE') {
      for (const id of op.sourceMemoryIds) supersededIds.add(id);
    }
    accepted.push(op);
  }

  logger.info('phase3:done', {
    input: operations.length,
    accepted: accepted.length,
    rejectedDuplicates,
  });

  return { accepted, rejectedDuplicates };
}
