export const DEFAULT_MAIN_MAX_STEPS = 30;

export const DEFAULT_CONTEXT_LIMIT = 128_000;

export const DEFAULT_SLIDING_WINDOW_ROUNDS = 5;

export const DEFAULT_THRESHOLD_TO_SUMMARY = 0.8;

export const COMPACTION_BUFFER = 20_000;

export const MIN_PRESERVE_RECENT_TOKENS = 2_000;

export const MAX_PRESERVE_RECENT_TOKENS = 8_000;

export const DEFAULT_TAIL_TURNS = 2;

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. Answer concisely and accurately.`;

export const DEFAULT_SUMMARY_PROMPT = `You are an anchored context summarization assistant.

Summarize the conversation history below. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Output a concise summary that captures:
- Key decisions and their rationale
- Important code changes or file modifications
- Unresolved questions or pending tasks
- User preferences and constraints
- Critical context needed to continue the work

Use terse bullets. Preserve exact file paths, commands, error strings, and identifiers when known. Do not mention that you are summarizing.`;

export const ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'running',
  'workflow_suspended',
  'waiting',
]);
