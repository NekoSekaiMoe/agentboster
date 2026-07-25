/**
 * Microcompact: fold old tool-result content without an LLM call.
 *
 * Borrowed from aionrs `crates/aion-agent/src/compact/micro.rs`. This is the
 * lightest of aionrs' three compaction tiers — Autocompact and Emergency
 * (already implemented in `compaction-core.ts` / `steps/compress.ts`) replace
 * whole message spans with an LLM-generated summary. Microcompact sits below
 * both: it walks the accumulated prompt, finds tool-result parts whose calling
 * tool is on the configurable `compactableTools` allowlist, and replaces the
 * *content* of all but the most recent N with a short placeholder — no LLM
 * call, no DB write, no persistence. The next compaction tier only fires if
 * the token budget is still blown after this pass.
 *
 * Why this matters: AgentBoster runs long-lived durable workflows where a
 * single session can accumulate dozens of file reads, shell outputs, and web
 * fetches. Each successful tool result is sometimes tens of KB. Without a
 * cheap folding pass, the agent hits the autocompact threshold sooner and
 * pays for an LLM summarization call it didn't need — the recent results are
 * still useful, the old ones are usually stale context the model no longer
 * cares about.
 *
 * Placement: applied in `prepareStep` BEFORE `evaluateCompactionNeed`, so the
 * token estimate reflects the folded state and autocompact only fires when
 * microcompact alone wasn't enough.
 *
 * Config: see `MicrocompactConfig`. Defaults are conservative
 * (keep-recent 4, compactable-tools = the verbose built-in tools) and can be
 * overridden via the existing autonomy / agent config surface.
 */
import type { ModelMessage } from 'ai';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('workflow.agent.microcompact');

/** Placeholder substituted in place of cleared tool-result output. */
export const CLEARED_TOOL_RESULT = '[Tool result cleared by microcompact]';

/**
 * Built-in tools whose results are typically large and lose relevance fast.
 * Tools NOT on this list (e.g. memory writes, handoffs, short control
 * probes) are left untouched. Mirrors aionrs' compactable_tools default.
 */
export const DEFAULT_COMPACTABLE_TOOLS = [
  'read_file',
  'read', // alias
  'list_files',
  'ls',
  'execute_command',
  'exec',
  'shell',
  'web_fetch',
  'web_search',
  'fetch',
  'search',
  'grep',
  'glob',
] as const;

export interface MicrocompactConfig {
  /** Master switch. When false, microcompact never runs. */
  enabled: boolean;
  /**
   * Keep the content of the N most-recent compactable tool results intact;
   * fold everything older. Minimum 1. Default 4.
   */
  keepRecent: number;
  /**
   * Tool names whose results are eligible for folding. Default
   * DEFAULT_COMPACTABLE_TOOLS.
   */
  compactableTools: readonly string[];
  /**
   * Only fold when the count of compactable live results exceeds this
   * threshold. Avoids folding on short conversations. Default = keepRecent*2.
   */
  minResultsToTrigger?: number;
}

export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: true,
  keepRecent: 4,
  compactableTools: DEFAULT_COMPACTABLE_TOOLS,
};

export interface MicrocompactResult {
  /** Number of tool-result parts whose content was cleared. */
  clearedCount: number;
  /** Rough token estimate freed (content bytes / 4). */
  estimatedTokensFreed: number;
  /** Whether the pass ran (trigger conditions met). */
  ran: boolean;
}

/** Sentinel result returned when the pass did not run. */
export const NOOP_RESULT: MicrocompactResult = {
  clearedCount: 0,
  estimatedTokensFreed: 0,
  ran: false,
};

/**
 * Resolve a config from a partial override, filling defaults. Accepts the
 * snake_case shape that the autonomy/config schema uses.
 */
export function resolveMicrocompactConfig(
  override?: Partial<{
    enabled: boolean;
    keep_recent: number;
    compactable_tools: readonly string[];
    min_results_to_trigger: number;
  }>,
): MicrocompactConfig {
  if (!override) return DEFAULT_MICROCOMPACT_CONFIG;
  return {
    enabled: override.enabled ?? DEFAULT_MICROCOMPACT_CONFIG.enabled,
    keepRecent: override.keep_recent ?? DEFAULT_MICROCOMPACT_CONFIG.keepRecent,
    compactableTools:
      override.compactable_tools ??
      DEFAULT_MICROCOMPACT_CONFIG.compactableTools,
    minResultsToTrigger: override.min_results_to_trigger,
  };
}

/**
 * Decide whether microcompact should run on this prompt.
 *
 * Borrowed from aionrs' `should_microcompact` count-trigger: run when the
 * number of compactable, non-cleared tool results exceeds the threshold
 * (default keepRecent*2). The time-based trigger from aionrs is omitted —
 * AgentBoster's prepareStep runs per-step, so "older than N seconds" is
 * implied by the step count anyway, and the count trigger is the more
 * predictable signal.
 */
export function shouldMicrocompact(
  messages: ModelMessage[],
  config: MicrocompactConfig,
): boolean {
  if (!config.enabled) return false;
  const threshold =
    config.minResultsToTrigger ?? Math.max(config.keepRecent * 2, 2);
  const count = countCompactableLiveResults(messages, config.compactableTools);
  return count > threshold;
}

/**
 * Fold old tool-result content in place (returns a new array; input untouched).
 *
 * Keeps the `keepRecent` most-recent compactable results intact and replaces
 * the content of older ones with {@link CLEARED_TOOL_RESULT}. Already-cleared
 * results don't count toward the keep budget and are left as-is.
 *
 * Pure / synchronous / no LLM call. Safe to run every step.
 */
export function microcompact(
  messages: ModelMessage[],
  config: MicrocompactConfig,
): { messages: ModelMessage[]; result: MicrocompactResult } {
  if (!config.enabled) {
    return { messages, result: NOOP_RESULT };
  }
  if (!shouldMicrocompact(messages, config)) {
    return { messages, result: NOOP_RESULT };
  }

  // Build tool_use_id -> toolName map by scanning assistant tool-call parts.
  const toolNames = buildToolNameMap(messages);
  const compactableSet = new Set(config.compactableTools);

  // Collect locations of all compactable, non-cleared tool results in order.
  const targets = collectCompactableLocations(
    messages,
    toolNames,
    compactableSet,
  );

  const keep = Math.max(config.keepRecent, 1);
  if (targets.length <= keep) {
    return { messages, result: NOOP_RESULT };
  }

  // Everything before the final `keep` is foldable.
  const toClear = targets.slice(0, targets.length - keep);

  // Clone messages lazily — only the messages we mutate need copying.
  // Each mutated message gets a shallow-cloned content array, and each
  // folded part gets a fresh object so we NEVER write through to the
  // caller's original part objects (microcompact must be pure).
  const out = messages.slice();
  const mutated = new Set<number>();
  let clearedCount = 0;
  let tokensFreed = 0;

  for (const [msgIdx] of toClear) {
    if (!mutated.has(msgIdx)) {
      const original = out[msgIdx];
      if (!original) continue;
      out[msgIdx] = {
        ...original,
        content: (original.content as readonly unknown[]).slice(),
      } as ModelMessage;
      mutated.add(msgIdx);
    }
  }

  for (const [msgIdx, partIdx] of toClear) {
    const msg = out[msgIdx];
    if (!msg) continue;
    const parts = msg.content as unknown[];
    const part = parts[partIdx] as
      | { output?: unknown; content?: unknown }
      | undefined;
    if (!part) continue;
    const before = estimateBytes(part.output ?? part.content);
    tokensFreed += Math.max(0, before / 4) | 0;
    // Clone the part before mutating so the caller's original stays intact.
    const cloned: Record<string, unknown> = { ...part };
    if ('output' in part) {
      cloned.output = CLEARED_TOOL_RESULT;
    } else if ('content' in part) {
      cloned.content = CLEARED_TOOL_RESULT;
    } else {
      continue;
    }
    parts[partIdx] = cloned;
    clearedCount += 1;
  }

  const result: MicrocompactResult = {
    clearedCount,
    estimatedTokensFreed: tokensFreed,
    ran: clearedCount > 0,
  };
  if (result.ran) {
    logger.info('microcompact:folded', {
      cleared: clearedCount,
      tokensFreed,
      kept: keep,
      totalCompactable: targets.length,
    });
  }
  return { messages: out, result };
}

// --- helpers ----------------------------------------------------------------

function buildToolNameMap(messages: ModelMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content as readonly unknown[]) {
      const p = part as {
        type?: string;
        toolCallId?: string;
        toolName?: string;
      };
      if (
        p.type === 'tool-call' &&
        typeof p.toolCallId === 'string' &&
        typeof p.toolName === 'string'
      ) {
        map.set(p.toolCallId, p.toolName);
      }
    }
  }
  return map;
}

function countCompactableLiveResults(
  messages: ModelMessage[],
  compactableTools: readonly string[],
): number {
  const toolNames = buildToolNameMap(messages);
  const compactableSet = new Set(compactableTools);
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const part of msg.content as readonly unknown[]) {
      if (isCompactableAndLive(part, toolNames, compactableSet)) {
        count += 1;
      }
    }
  }
  return count;
}

function collectCompactableLocations(
  messages: ModelMessage[],
  toolNames: Map<string, string>,
  compactableSet: Set<string>,
): Array<[number, number]> {
  const locations: Array<[number, number]> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg) continue;
    if (msg.role !== 'tool') continue;
    const parts = msg.content as readonly unknown[];
    for (let bi = 0; bi < parts.length; bi++) {
      if (isCompactableAndLive(parts[bi], toolNames, compactableSet)) {
        locations.push([mi, bi]);
      }
    }
  }
  return locations;
}

function isCompactableAndLive(
  part: unknown,
  toolNames: Map<string, string>,
  compactableSet: Set<string>,
): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as {
    toolCallId?: string;
    output?: unknown;
    content?: unknown;
  };
  if (typeof p.toolCallId !== 'string') return false;
  // Already cleared?
  const out = p.output ?? p.content;
  if (out === CLEARED_TOOL_RESULT) return false;
  const name = toolNames.get(p.toolCallId);
  if (!name) return false;
  return compactableSet.has(name);
}

function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}
