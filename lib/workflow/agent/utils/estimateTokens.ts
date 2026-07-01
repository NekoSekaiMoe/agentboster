/**
 * Token estimation helpers.
 *
 * Re-exports from the shared compaction-core module so the Web agent loop
 * and the CLI compaction path use identical heuristics. See
 * `lib/workflow/agent/compaction-core.ts`.
 */
export {
  estimateTextTokens,
  estimatePromptTokens,
  estimateMessageTokensFromUsage,
} from '../compaction-core';
