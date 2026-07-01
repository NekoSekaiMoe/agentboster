/**
 * Compaction threshold and decision helpers.
 *
 * Re-exports from the shared compaction-core module so the Web agent loop
 * and the CLI compaction path use identical semantics. See
 * `lib/workflow/agent/compaction-core.ts`.
 */
export {
  computeUsableContext,
  shouldCompress,
  isContextOverflow,
  evaluateCompactionNeed,
  type CompactionDecision,
  DEFAULT_COMPACT_RATIO as DEFAULT_THRESHOLD,
  DEFAULT_COMPACTION_BUFFER as COMPACTION_BUFFER,
} from '../compaction-core';
