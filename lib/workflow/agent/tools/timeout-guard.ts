/**
 * Cooperative tool-call timeout guard.
 *
 * Adapted from DeepSeek Harness `packages/guard/timeout-policy/src/index.ts`
 * (see ref/deepseek-harness). Differences from the original:
 *  - agentboster tools return plain JSON objects (`{ ok: false, error }` is
 *    the repo convention), not dsh's content-array ToolExecutionResult, so
 *    the timeout result follows the repo shape with a structured
 *    `code: 'TOOL_TIMEOUT'` field downstream logic can route on.
 *  - Instead of Cordis `tools/execute` waterfall listeners, this is a plain
 *    higher-order wrapper composed inside `defineBuildInTool.register()`
 *    (inside `withToolExecutionLogger`, so the activity log still records
 *    the timeout result as the tool's outcome).
 *
 * Semantics preserved from dsh:
 *  - Cooperative: a derived AbortSignal (linked to the upstream SDK signal +
 *    our deadline) is swapped onto the options passed to the tool body; the
 *    original options object is never mutated, so post-execution code still
 *    sees the upstream signal. Tools that honor `options.abortSignal` can
 *    cancel server-side work when the deadline fires.
 *  - Ownership-scoped expiry: the timeout result replaces the outcome ONLY
 *    when OUR timer fired. An upstream cancellation (run aborted, step
 *    cancelled) surfaces as the tool's own rejection/error, never as
 *    TOOL_TIMEOUT — orthogonal outcome flags are reported independently.
 *  - No-budget tools are delegated through unchanged.
 *
 * Non-goal: timing out `AsyncIterable`-returning executes (streaming tools).
 * Those settle the race with the iterable itself and pass through — the
 * deadline only applies to promise-returning executes.
 */
import { createLogger } from '@/lib/utils/logger';
import type { ToolSet } from 'ai';

const logger = createLogger('workflow.agent.tools.timeout-guard');

/**
 * Structured code this guard owns. `timedOut` and `code` are separate facts
 * (orthogonal outcome reporting): a tool can be cancelled upstream without
 * ever being timed out by this guard, and vice versa.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT';

export interface ToolTimeoutResult {
  ok: false;
  code: typeof TOOL_TIMEOUT;
  timedOut: true;
  /** Model-facing message. */
  error: string;
  /** The budget that elapsed, in ms. */
  timeoutMs: number;
}

function toolTimeoutResult(timeoutMs: number): ToolTimeoutResult {
  const message = `tool call timed out after ${timeoutMs}ms`;
  return {
    ok: false,
    code: TOOL_TIMEOUT,
    timedOut: true,
    error: `Error: ${message}`,
    timeoutMs,
  };
}

/**
 * Resolve the per-tool timeout budget.
 *
 * Priority: tool entry config `timeoutMs` > env `AGENT_TOOL_DEFAULT_TIMEOUT_MS`.
 * Missing/invalid/non-positive values mean "no budget" (undefined) — the
 * wrapper then delegates unchanged, mirroring dsh's default-off behavior.
 */
export function resolveToolTimeoutMs(
  config: Record<string, string | undefined> | undefined,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw =
    config?.timeoutMs?.trim() || env.AGENT_TOOL_DEFAULT_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn('timeout_guard:invalid_timeout_ms', { raw });
    return undefined;
  }
  return parsed;
}

interface Deadline {
  /** Derived signal: aborts on upstream abort OR our own timer. */
  signal: AbortSignal;
  /** Resolves with `true` ONLY when this guard's own timer fires. */
  timedOut: Promise<true>;
  /** Synchronous flag — true once our own timer fired. Covers the case
   *  where a cooperative tool settles (post-abort) in the same microtask
   *  tick as the timer callback and wins the race: dsh semantics say the
   *  result is still replaced, because the budget did elapse. */
  fired: boolean;
  dispose(): void;
}

function armDeadline(
  timeoutMs: number,
  upstream: AbortSignal | undefined,
): Deadline {
  const controller = new AbortController();
  let resolveTimedOut!: (v: true) => void;
  const timedOut = new Promise<true>((resolve) => {
    resolveTimedOut = resolve;
  });
  const deadline: Deadline = {
    signal: controller.signal,
    timedOut,
    fired: false,
    dispose: () => undefined,
  };
  const timer = setTimeout(() => {
    // Our own deadline: flip the derived signal (cooperative tools observe
    // it) and flag expiry. Upstream aborts never set `fired` / resolve
    // `timedOut`.
    deadline.fired = true;
    controller.abort();
    resolveTimedOut(true);
  }, timeoutMs);
  const onUpstreamAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener('abort', onUpstreamAbort);
  }
  deadline.dispose = () => {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  };
  return deadline;
}

/**
 * Wrap a tool's execute with the cooperative deadline described above.
 * Returns the tool unchanged when there is no budget or nothing to wrap.
 */
export function withToolTimeout(
  tool: ToolSet[string],
  options: { timeoutMs?: number },
): ToolSet[string] {
  const execute = tool.execute;
  if (!execute || options.timeoutMs === undefined) {
    return tool;
  }
  const { timeoutMs } = options;

  return {
    ...tool,
    execute: async (input, execOptions) => {
      const deadline = armDeadline(timeoutMs, execOptions?.abortSignal);
      try {
        const result = await Promise.race([
          Promise.resolve(
            execute(input, {
              ...execOptions,
              abortSignal: deadline.signal,
            }),
          ),
          deadline.timedOut,
        ]);
        if (result === true || deadline.fired) {
          // Our timer fired — either the sentinel won the race, or a
          // cooperative tool settled post-abort in the same tick and the
          // race picked its value. Either way the budget elapsed: replace
          // the outcome with the structured timeout result the model sees.
          logger.warn('timeout_guard:fired', { timeoutMs });
          return toolTimeoutResult(timeoutMs);
        }
        return result;
      } finally {
        deadline.dispose();
      }
    },
  };
}
