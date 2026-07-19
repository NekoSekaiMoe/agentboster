// Source: lib/workflow/agent/types/index.ts
//
// Mirrors the token-usage / compress core types used by the workflow
// runtime. The runtime is the source of truth — when these shapes
// change upstream, regenerate. The SDK does NOT import the runtime
// (the `@/lib/...` path is not resolvable here), so each type is
// re-declared locally and pointed back at its source.

// Source: lib/workflow/agent/types/index.ts
export type TokenUsageBucket =
  | number
  | {
      total?: number;
      noCache?: number;
      cacheRead?: number;
      cacheWrite?: number;
      text?: number;
      reasoning?: number;
    };

/**
 * Token Usage record for a workflow run or a step.
 *
 * Source: lib/workflow/agent/types/index.ts
 */
export interface TokenUsage extends Record<string, unknown> {
  inputTokens?: TokenUsageBucket;
  outputTokens?: TokenUsageBucket;
  totalTokens?: number;
}

/**
 * Result of compressing conversation context, including the generated
 * summary and the compressed messages in a format suitable for
 * preparing the next step's input.
 *
 * Source: lib/workflow/agent/types/index.ts
 *
 * NOTE: `compressedMessages` mirrors `LanguageModelV3Prompt` from
 * `@ai-sdk/provider`. That type is a deep union of message-role
 * shapes that the SDK does not need to introspect — consumers that
 * want the real shape should depend on `@ai-sdk/provider` directly.
 * Marked `unknown` here to avoid pulling in the provider package.
 * TODO: tighten when ai-sdk types are vendored.
 */
export interface CompressResult {
  summaryText: string;
  compressedMessages: unknown;
}

/**
 * Extract a finite numeric total from a TokenUsageBucket-like value.
 *
 * Source: lib/workflow/agent/types/index.ts — `getTokenUsageTotal`.
 *
 * Only the function signature is part of the SDK contract; the runtime
 * implementation wins at load time. The body here is the canonical
 * algorithm mirrored from the source so consumers that import the SDK
 * standalone (without the runtime alias) still get correct behavior.
 */
export function getTokenUsageTotal(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return 0;
  }

  const total = (value as { total?: unknown }).total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * Aggregate token usage from multiple step-result-like records into a
 * single TokenUsage.
 *
 * Source: lib/workflow/agent/types/index.ts — `aggregateTokenUsage`.
 *
 * The runtime version is typed against `StepResult<ToolSet>` from the
 * `ai` package; the SDK avoids that dependency by accepting any
 * `{ usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: number } }`
 * shape. The numeric aggregation is identical to the source.
 */
export function aggregateTokenUsage(
  steps: ReadonlyArray<{
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      totalTokens?: number;
    };
  }>,
): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  for (const step of steps) {
    const usage = step.usage;
    if (usage) {
      inputTokens += getTokenUsageTotal(usage.inputTokens);
      outputTokens += getTokenUsageTotal(usage.outputTokens);
      totalTokens += usage.totalTokens ?? 0;
    }
  }

  return { inputTokens, outputTokens, totalTokens };
}
