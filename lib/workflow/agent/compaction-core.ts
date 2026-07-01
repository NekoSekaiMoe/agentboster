/**
 * Compaction core — shared between Web (lib/) and CLI (subpackage/cli/packages/coding-agent/)
 * via symlink. Pure functions only: no Node/Next/DB imports.
 *
 * Threshold semantics, token estimation, and the structured summary prompt
 * are unified here so both compaction code paths stay in lockstep.
 */

// ============================================================================
// Threshold / decision
// ============================================================================

/** Default ratio of context-limit usage that triggers compaction. */
export const DEFAULT_COMPACT_RATIO = 0.8;

/** Token buffer reserved below the context limit before overflow. */
export const DEFAULT_COMPACTION_BUFFER = 20_000;

/** Minimum tail budget preserved when splitting head/tail. */
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;

/** Maximum tail budget preserved when splitting head/tail. */
export const MAX_PRESERVE_RECENT_TOKENS = 8_000;

/**
 * Usable context window after reserving space for output + safety buffer.
 */
export function computeUsableContext(
  contextLimit: number,
  maxOutputTokens: number,
  buffer = DEFAULT_COMPACTION_BUFFER,
): number {
  if (contextLimit <= 0) return 0;
  const reserved = Math.min(buffer, maxOutputTokens);
  return Math.max(0, contextLimit - reserved);
}

export function shouldCompress(
  totalTokensUsed: number,
  contextLimit: number | undefined,
  threshold = DEFAULT_COMPACT_RATIO,
  force = false,
): boolean {
  if (force) return true;
  if (!contextLimit || contextLimit <= 0) return false;
  return totalTokensUsed >= contextLimit * threshold;
}

export function isContextOverflow(
  totalTokensUsed: number,
  contextLimit: number,
  maxOutputTokens: number,
  buffer = DEFAULT_COMPACTION_BUFFER,
): boolean {
  if (contextLimit <= 0) return false;
  const usable = computeUsableContext(contextLimit, maxOutputTokens, buffer);
  return usable > 0 && totalTokensUsed >= usable;
}

export interface CompactionDecision {
  shouldCompress: boolean;
  isOverflow: boolean;
  totalTokens: number;
  contextLimit: number;
  usableContext: number;
  usageRatio: number;
}

export function evaluateCompactionNeed(input: {
  totalTokensUsed: number;
  contextLimit: number;
  maxOutputTokens: number;
  threshold?: number;
  buffer?: number;
  force?: boolean;
}): CompactionDecision {
  const usable = computeUsableContext(
    input.contextLimit,
    input.maxOutputTokens,
    input.buffer,
  );
  const threshold = input.threshold ?? DEFAULT_COMPACT_RATIO;
  const force = input.force ?? false;

  const ratio =
    input.contextLimit > 0 ? input.totalTokensUsed / input.contextLimit : 0;

  const overflow = isContextOverflow(
    input.totalTokensUsed,
    input.contextLimit,
    input.maxOutputTokens,
    input.buffer,
  );

  const compress =
    force ||
    shouldCompress(
      input.totalTokensUsed,
      input.contextLimit,
      threshold,
      false,
    ) ||
    overflow;

  return {
    shouldCompress: compress,
    isOverflow: overflow,
    totalTokens: input.totalTokensUsed,
    contextLimit: input.contextLimit,
    usableContext: usable,
    usageRatio: ratio,
  };
}

// ============================================================================
// Token estimation (chars/4 heuristic)
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

function estimateContentChars(
  content: string | ReadonlyArray<{ type: string; text?: string }>,
): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      chars += block.text.length;
    } else if (block.type === 'image') {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

/**
 * Estimate tokens for a message-like payload. Accepts the minimal shape used
 * by both Web (ModelMessage) and CLI (AgentMessage) so neither has to adapt.
 */
export function estimateMessageTokens(message: {
  role: string;
  content: string | ReadonlyArray<unknown>;
}): number {
  const chars = estimateContentChars(
    message.content as string | ReadonlyArray<{ type: string; text?: string }>,
  );
  return Math.ceil(chars / 4);
}

type PromptMessage = {
  content: string | ReadonlyArray<unknown>;
};

export function estimatePromptTokens(
  messages: ReadonlyArray<PromptMessage>,
): number {
  return messages.reduce(
    (total, m) =>
      total +
      estimateContentChars(
        m.content as string | ReadonlyArray<{ type: string; text?: string }>,
      ) /
        4,
    0,
  );
}

export function estimateMessageTokensFromUsage(
  usage:
    | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
    | unknown,
): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  if (typeof u.totalTokens === 'number' && u.totalTokens > 0)
    return u.totalTokens;
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  return input + output;
}

// ============================================================================
// Summary prompts (structured, shared)
// ============================================================================

export const SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARY_PROMPT_INITIAL = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

## What to Preserve (in priority order)
When trimming is needed, preserve in this order — unresolved questions and blockers → action outcomes (tool runs, command results, file changes, success/failure status) → **user preferences and constraints, including security-decision preferences** (e.g., "user authorized git_push for 1 hour starting 14:00", "user always rejects direct file deletions", "user prefers docker-strict for untrusted code") → resolved factual exchanges.

## What to Strip
Eliminate pleasantries, empathetic filler, transition words, and repeated explanations. Write in concise third-person ("User said…", "Agent executed…", "Command returned…").

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const SUMMARY_PROMPT_UPDATE = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- When trimming is needed, preserve in this order — unresolved questions and blockers → action outcomes → **user preferences and constraints, especially security-decision preferences** (L2 authorization habits, sandbox tier preferences) → resolved factual exchanges
- Eliminate pleasantries, empathetic filler, and repeated explanations; write in concise third-person
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
