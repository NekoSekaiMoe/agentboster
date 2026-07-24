/**
 * Provider compatibility layer for message/tool normalization.
 *
 * Borrowed from aionrs' `ProviderCompat`
 * (`crates/aion-config/src/compat.rs`): instead of hard-coding `if (provider
 * === 'anthropic')` branches across the agent loop, surface each provider's
 * message-shape quirks as a small set of boolean/string toggles, then run a
 * single normalization pass over the prompt right before it is sent.
 *
 * AgentBoster runs on the Vercel AI SDK, whose per-provider factories already
 * emit the correct wire format (Responses vs Chat Completions, Anthropic
 * input_schema vs OpenAI function, etc.). So this layer intentionally does
 * NOT reproduce aionrs' transport-level compat (api_path, max_tokens_field,
 * tool_wire_shape ...) — the AI SDK handles that. What the AI SDK does NOT
 * do, and what aionrs had to do itself, is repair the *logical* shape of the
 * accumulated message history before each request:
 *
 *   - consecutive assistant turns collapsed into one (OpenAI rejects
 *     adjacent same-role messages on some compatible endpoints),
 *   - orphan tool_use blocks (no matching tool_result) stripped (strict
 *     providers like DeepSeek/Ollama return 400 for these),
 *   - user/assistant alternation enforced with a filler text part
 *     (Anthropic requires strict alternation),
 *   - duplicate tool results for the same tool_call_id deduplicated.
 *
 * These are exactly the normalizations aionrs applies in
 * `sanitize_session_messages` + the MessageCompat flags. Defaults are
 * resolved from the provider `format` (anthropic-family vs openai-family),
 * matching aionrs' `anthropic_defaults()` / `openai_defaults()`. Users can
 * override any flag via `compat` on the provider config.
 */
import type { ModelMessage } from 'ai';
import type { AIProviderConfig } from '@/types/config/ai';

/**
 * Resolved compatibility flags (all booleans, defaults already applied).
 * Transport-level toggles from aionrs (max_tokens_field, api_path, ...) are
 * intentionally omitted — the AI SDK owns the wire shape.
 */
export interface ProviderCompat {
  /** Merge consecutive assistant messages (text concat + tool_calls merge). */
  mergeAssistantMessages: boolean;
  /** Remove tool_result parts that have no matching tool_call. */
  cleanOrphanToolResults: boolean;
  /** Remove tool_call parts that have no matching tool_result. */
  cleanOrphanToolCalls: boolean;
  /** Deduplicate tool results with the same tool_call_id (keep last). */
  dedupToolResults: boolean;
  /** Ensure messages alternate user/assistant (insert filler if needed). */
  ensureAlternation: boolean;
  /** Merge consecutive same-role messages into one. */
  mergeSameRole: boolean;
}

/** User-facing override shape (every field optional, snake_case). */
export interface ProviderCompatOverrides {
  merge_assistant_messages?: boolean;
  clean_orphan_tool_results?: boolean;
  clean_orphan_tool_calls?: boolean;
  dedup_tool_results?: boolean;
  ensure_alternation?: boolean;
  merge_same_role?: boolean;
}

/**
 * Defaults per provider format, mirroring aionrs' `anthropic_defaults()` and
 * `openai_defaults()`. The split is: anthropic-family needs strict
 * alternation + same-role merge; openai-family needs assistant merge + orphan
 * cleanup + dedup. google is treated like openai (AI SDK handles its quirks).
 */
const COMPAT_DEFAULTS: Record<AIProviderConfig['format'], ProviderCompat> = {
  anthropic: {
    mergeAssistantMessages: false,
    cleanOrphanToolResults: true,
    cleanOrphanToolCalls: false,
    dedupToolResults: false,
    ensureAlternation: true,
    mergeSameRole: true,
  },
  openai: {
    mergeAssistantMessages: true,
    cleanOrphanToolResults: true,
    cleanOrphanToolCalls: true,
    dedupToolResults: true,
    ensureAlternation: false,
    mergeSameRole: false,
  },
  // OpenAI-compatible third-party endpoints (DeepSeek, GLM, Ollama, ...).
  // These are the most fragile — apply every repair. This is the bucket that
  // motivated borrowing aionrs' compat layer in the first place.
  openaicompatible: {
    mergeAssistantMessages: true,
    cleanOrphanToolResults: true,
    cleanOrphanToolCalls: true,
    dedupToolResults: true,
    ensureAlternation: true,
    mergeSameRole: true,
  },
  google: {
    mergeAssistantMessages: true,
    cleanOrphanToolResults: true,
    cleanOrphanToolCalls: false,
    dedupToolResults: true,
    ensureAlternation: false,
    mergeSameRole: false,
  },
};

/** A no-op compat that leaves messages untouched. */
export const NOOP_COMPAT: ProviderCompat = {
  mergeAssistantMessages: false,
  cleanOrphanToolResults: false,
  cleanOrphanToolCalls: false,
  dedupToolResults: false,
  ensureAlternation: false,
  mergeSameRole: false,
};

/**
 * Resolve effective compat flags: defaults for the provider format, with any
 * user overrides winning on a per-flag basis (matching aionrs' `merge()`).
 */
export function resolveProviderCompat(
  format: AIProviderConfig['format'],
  overrides?: ProviderCompatOverrides,
): ProviderCompat {
  const base = COMPAT_DEFAULTS[format] ?? NOOP_COMPAT;
  if (!overrides) return base;
  return {
    mergeAssistantMessages:
      overrides.merge_assistant_messages ?? base.mergeAssistantMessages,
    cleanOrphanToolResults:
      overrides.clean_orphan_tool_results ?? base.cleanOrphanToolResults,
    cleanOrphanToolCalls:
      overrides.clean_orphan_tool_calls ?? base.cleanOrphanToolCalls,
    dedupToolResults: overrides.dedup_tool_results ?? base.dedupToolResults,
    ensureAlternation: overrides.ensure_alternation ?? base.ensureAlternation,
    mergeSameRole: overrides.merge_same_role ?? base.mergeSameRole,
  };
}

/**
 * Apply all enabled compat normalizations to a message list. Returns a new
 * array; the input is not mutated. Order of operations matches aionrs:
 *   1. dedup tool results (so orphan detection sees the surviving set)
 *   2. strip orphan tool calls / results (pairwise)
 *   3. merge consecutive same-role / assistant-only merges
 *   4. enforce alternation last (operates on the cleaned, merged stream)
 *
 * Cheap fast path: if every flag is off, return the input unchanged.
 */
export function applyMessageCompat(
  messages: ModelMessage[],
  compat: ProviderCompat,
): ModelMessage[] {
  const isNoop =
    !compat.dedupToolResults &&
    !compat.cleanOrphanToolCalls &&
    !compat.cleanOrphanToolResults &&
    !compat.mergeAssistantMessages &&
    !compat.mergeSameRole &&
    !compat.ensureAlternation;
  if (isNoop) return messages;

  let out = messages.slice();

  if (compat.dedupToolResults) {
    out = dedupToolResults(out);
  }
  if (compat.cleanOrphanToolCalls || compat.cleanOrphanToolResults) {
    out = stripOrphanToolBlocks(out, compat);
  }
  if (compat.mergeAssistantMessages || compat.mergeSameRole) {
    out = mergeConsecutive(out, compat);
  }
  if (compat.ensureAlternation) {
    out = enforceAlternation(out);
  }
  return out;
}

// --- Individual normalizations ---------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function dedupToolResults(messages: ModelMessage[]): ModelMessage[] {
  // Collect the last index for each tool_call_id appearing in a tool result;
  // any earlier result for the same id is dropped (the call is repeated
  // verbatim elsewhere). Mirrors aionrs `dedup_tool_results`.
  const lastSeen = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      for (const part of (
        m.content as readonly { toolCallId?: string }[]
      ).flat()) {
        const id = (part as { toolCallId?: string }).toolCallId;
        if (typeof id === 'string') lastSeen.set(id, i);
      }
    }
  });
  if (lastSeen.size === 0) return messages;

  const result: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') {
      result.push(m);
      continue;
    }
    // Keep this tool message only if at least one of its results is the
    // last-seen for its id. Parts that are supersers are filtered out; if all
    // parts are superseded the whole message is dropped.
    const keptParts = (m.content as unknown[])
      .map((part) => {
        const id = (part as { toolCallId?: string }).toolCallId;
        if (typeof id === 'string' && lastSeen.get(id) !== i) return null;
        return part;
      })
      .filter((p) => p !== null);
    if (keptParts.length > 0) {
      result.push({ ...m, content: keptParts as typeof m.content });
    }
  }
  return result;
}

function stripOrphanToolBlocks(
  messages: ModelMessage[],
  compat: ProviderCompat,
): ModelMessage[] {
  // Pass 1: collect every tool_call_id that has a matching tool_result and
  // vice versa. (aionrs `sanitize_session_messages`.)
  const callsWithResult = new Set<string>();
  const resultsWithCall = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const part of m.content as readonly unknown[]) {
        const id = (part as { type?: string; toolCallId?: string }).toolCallId;
        if (
          typeof id === 'string' &&
          (part as { type?: string }).type === 'tool-call'
        ) {
          // mark as seen; resolved below
          if (!callsWithResult.has(id)) callsWithResult.add(`${id}__pending`);
        }
      }
    } else if (m.role === 'tool') {
      for (const part of m.content as readonly unknown[]) {
        const id = (part as { toolCallId?: string }).toolCallId;
        if (typeof id === 'string') resultsWithCall.add(id);
      }
    }
  }
  // Resolve pending -> real set of calls that DO have a result.
  const callsHaveResult = new Set<string>();
  for (const marker of callsWithResult) {
    const id = marker.replace(/__pending$/, '');
    if (resultsWithCall.has(id)) callsHaveResult.add(id);
  }

  // Pass 2: walk messages, filtering parts.
  const result: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && compat.cleanOrphanToolCalls) {
      const filtered = (m.content as readonly unknown[]).filter((part) => {
        const type = (part as { type?: string }).type;
        const id = (part as { toolCallId?: string }).toolCallId;
        if (type === 'tool-call' && typeof id === 'string') {
          return callsHaveResult.has(id);
        }
        return true; // keep text / reasoning / file parts
      });
      if (filtered.length > 0) {
        result.push({ ...m, content: filtered as typeof m.content });
      }
    } else if (m.role === 'tool' && compat.cleanOrphanToolResults) {
      const filtered = (m.content as readonly unknown[]).filter((part) => {
        const id = (part as { toolCallId?: string }).toolCallId;
        if (typeof id !== 'string') return true;
        // Keep only results whose call still exists somewhere.
        return callExists(messages, id);
      });
      if (filtered.length > 0) {
        result.push({ ...m, content: filtered as typeof m.content });
      }
    } else {
      result.push(m);
    }
  }
  return result;
}

function callExists(messages: ModelMessage[], toolCallId: string): boolean {
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const part of m.content as readonly unknown[]) {
      if (
        (part as { type?: string }).type === 'tool-call' &&
        (part as { toolCallId?: string }).toolCallId === toolCallId
      ) {
        return true;
      }
    }
  }
  return false;
}

function mergeConsecutive(
  messages: ModelMessage[],
  compat: ProviderCompat,
): ModelMessage[] {
  if (messages.length === 0) return messages;
  const result: ModelMessage[] = [messages[0]!];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1]!;
    const cur = messages[i]!;
    const sameRole = prev.role === cur.role;

    // mergeAssistantMessages only collapses assistant→assistant.
    const shouldMergeAssistants =
      compat.mergeAssistantMessages && sameRole && cur.role === 'assistant';
    // mergeSameRole collapses any same-role adjacency.
    const shouldMergeSameRole = compat.mergeSameRole && sameRole;

    if (shouldMergeAssistants || shouldMergeSameRole) {
      // Concatenate content arrays. Types differ per role but content is
      // always an array of parts; we keep the union as `unknown[]` and cast
      // back to the role's content type via the spread.
      const mergedContent = [
        ...(prev.content as readonly unknown[]),
        ...(cur.content as readonly unknown[]),
      ] as unknown as Mutable<typeof cur.content>;
      result[result.length - 1] = {
        ...prev,
        content: mergedContent as typeof prev.content,
      } as ModelMessage;
    } else {
      result.push(cur);
    }
  }
  return result;
}

function enforceAlternation(messages: ModelMessage[]): ModelMessage[] {
  // Anthropic requires strict user/assistant alternation. We treat 'tool'
  // role messages as 'user' for alternation purposes (AI SDK maps tool
  // results to the user turn on Anthropic's wire). Insert a minimal filler
  // user message ('k.') whenever two assistant-bearing turns would be
  // adjacent, and drop empty leading/trailing assistant messages.
  if (messages.length === 0) return messages;

  type Bucket = 'system' | 'user' | 'assistant';
  const bucketOf = (m: ModelMessage): Bucket => {
    if (m.role === 'system') return 'system';
    if (m.role === 'assistant') return 'assistant';
    return 'user'; // 'user' and 'tool' both count as user-side
  };

  const result: ModelMessage[] = [];
  let lastBucket: Bucket = 'system';
  for (const m of messages) {
    const b = bucketOf(m);
    if (b === 'assistant' && lastBucket === 'assistant') {
      // Insert a filler user turn.
      result.push({
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
      } as ModelMessage);
    }
    result.push(m);
    lastBucket = b;
  }
  // If the last message is an assistant turn with no trailing user/tool, the
  // provider may refuse; leave it as-is — the AI SDK appends its own turn
  // next, and a trailing assistant message is valid for prefill scenarios.
  return result;
}
