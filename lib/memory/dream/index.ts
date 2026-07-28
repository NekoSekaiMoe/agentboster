/**
 * Dream system public surface.
 *
 * Pipeline modules are intentionally NOT re-exported here — the only
 * intended caller is the orchestrator. External code (cron route, admin
 * UI, tests) goes through `runDreamForUser` or the DAL.
 */

export { runDreamForUser } from './orchestrator';
export type { DreamRunOutcome } from './orchestrator';
export type {
  DreamOperation,
  DreamRunResult,
  DreamMeta,
  MemoryStatus,
  SourceKind,
} from './types';
export {
  bigramSimilarity,
  dedupeNearDuplicateContents,
  isNearDuplicate,
  wordBigrams,
} from './bigram';
