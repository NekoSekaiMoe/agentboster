/**
 * Tool-loop circuit breakers for the agent step loop.
 *
 * Borrowed from aionrs (`crates/aion-agent/src/tool_call.rs`): aionrs guards
 * the model's tool-call loop with four independent trackers. We reproduce the
 * same four here in TS so the DurableAgent stream in `lib/workflow/agent` can
 * abort a runaway loop early instead of burning API credit on `maxSteps`
 * (default 30) worth of identical failing calls.
 *
 * The four breakers (any one tripping aborts the run):
 *
 *   1. malformed       — consecutive rounds where every tool call had a
 *                        structurally invalid shape (empty name / empty id /
 *                        unknown tool). Mirrors aionrs'
 *                        `ToolCallMalformedTracker`. The AI SDK already maps
 *                        unknown tools to a trap result, so "malformed" here
 *                        collapses to "round resolved to no usable call".
 *
 *   2. failure         — consecutive rounds whose tool-result fingerprint is
 *                        byte-identical to the previous round's fingerprint
 *                        AND every result was an error. This is the "stuck
 *                        retrying the exact same call" signal. Mirrors
 *                        `ToolCallFailureTracker`.
 *
 *   3. allError        — consecutive rounds in which every executed tool
 *                        returned an error, regardless of fingerprint.
 *                        Mirrors `ToolCallAllErrorRoundTracker`.
 *
 *   4. cycle           — periodic repetition: the last K rounds repeat a
 *                        sub-sequence of length 2..PERIOD. Catches A→B→A→B
 *                        ping-pong loops that the exact-match failure tracker
 *                        misses. Mirrors `ToolCallCycleTracker`.
 *
 * Each `observe()` call returns the updated count; `tripReason()` returns a
 * non-null `LoopTripReason` when any breaker has exceeded its limit, which
 * the agent loop turns into a streamed error + thrown abort.
 *
 * Limits are configurable but default to aionrs' defaults (3/3/8/3).
 */
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('workflow.agent.tool-loop-guard');

/** Default limits, copied from aionrs `tool_call.rs` lines 3-6. */
export const DEFAULT_MAX_TOOL_CALL_MALFORMED_TURNS = 3;
export const DEFAULT_MAX_TOOL_CALL_FAILURE_TURNS = 3;
export const DEFAULT_MAX_ALL_ERROR_TOOL_ROUNDS = 8;
export const DEFAULT_MAX_TOOL_CALL_CYCLE_REPETITIONS = 3;
/** Longest cycle period we bother detecting (aionrs: 4). */
const MAX_TOOL_CALL_CYCLE_PERIOD = 4;

export interface ToolLoopGuardLimits {
  maxMalformedTurns: number;
  maxFailureTurns: number;
  maxAllErrorRounds: number;
  maxCycleRepetitions: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: ToolLoopGuardLimits = {
  maxMalformedTurns: DEFAULT_MAX_TOOL_CALL_MALFORMED_TURNS,
  maxFailureTurns: DEFAULT_MAX_TOOL_CALL_FAILURE_TURNS,
  maxAllErrorRounds: DEFAULT_MAX_ALL_ERROR_TOOL_ROUNDS,
  maxCycleRepetitions: DEFAULT_MAX_TOOL_CALL_CYCLE_REPETITIONS,
};

/**
 * Resolve effective limits from a (possibly partial) user config, falling
 * back to defaults. A limit of 0 disables that breaker (matches aionrs'
 * `is_limit_exceeded` short-circuit).
 *
 * Accepts the DB/API snake_case shape (`max_malformed_turns` etc.) used by
 * `types/config/autonomy.ts` and maps it to the camelCase fields the guard
 * uses internally.
 */
export function resolveToolLoopLimits(
  override?:
    | Partial<ToolLoopGuardLimits>
    | {
        max_malformed_turns?: number;
        max_failure_turns?: number;
        max_all_error_rounds?: number;
        max_cycle_repetitions?: number;
      }
    | undefined,
): ToolLoopGuardLimits {
  if (!override) return { ...DEFAULT_TOOL_LOOP_LIMITS };
  const o = override as Partial<ToolLoopGuardLimits> & {
    max_malformed_turns?: number;
    max_failure_turns?: number;
    max_all_error_rounds?: number;
    max_cycle_repetitions?: number;
  };
  return {
    maxMalformedTurns:
      o.maxMalformedTurns ??
      o.max_malformed_turns ??
      DEFAULT_TOOL_LOOP_LIMITS.maxMalformedTurns,
    maxFailureTurns:
      o.maxFailureTurns ??
      o.max_failure_turns ??
      DEFAULT_TOOL_LOOP_LIMITS.maxFailureTurns,
    maxAllErrorRounds:
      o.maxAllErrorRounds ??
      o.max_all_error_rounds ??
      DEFAULT_TOOL_LOOP_LIMITS.maxAllErrorRounds,
    maxCycleRepetitions:
      o.maxCycleRepetitions ??
      o.max_cycle_repetitions ??
      DEFAULT_TOOL_LOOP_LIMITS.maxCycleRepetitions,
  };
}

export type LoopTripReason =
  /** Every tool call malformed for N consecutive rounds. */
  | 'malformed'
  /** Identical failing fingerprint repeated for N consecutive rounds. */
  | 'failure'
  /** Every tool errored (any fingerprint) for N consecutive rounds. */
  | 'all_error'
  /** Periodic repetition of length 2..PERIOD detected. */
  | 'cycle';

export interface ToolLoopSnapshot {
  malformedCount: number;
  failureCount: number;
  allErrorCount: number;
  /** Best (longest / shortest-period) cycle detected this run, if any. */
  cycle: { period: number; repetitions: number } | null;
  tripped: LoopTripReason | null;
}

/** A single tool call within an observed round. */
export interface ObservedToolCall {
  name: string;
  /** Stable JSON of the call input, used for fingerprinting. */
  inputKey: string;
  /** Whether the model emitted this call in a structurally valid shape. */
  malformed: boolean;
  /** Whether the executed result was an error. */
  error: boolean;
}

/**
 * Compact per-round fingerprint: the sorted list of (name, inputKey) for the
 * calls that were *executed and errored*. Order-independent so re-ordering the
 * same failing batch still counts as the same fingerprint (aionrs compares the
 * full call list; we collapse to erroring calls only, which is the subset that
 * actually drives the failure/cycle breakers).
 */
interface RoundFingerprint {
  erroringCalls: string[];
}

function fingerprintOf(calls: ObservedToolCall[]): RoundFingerprint | null {
  const erroring = calls
    .filter((c) => !c.malformed && c.error)
    .map((c) => `${c.name}::${c.inputKey}`);
  if (erroring.length === 0) return null;
  // Sort for order-independence; same set of failing calls == same fingerprint.
  erroring.sort();
  return { erroringCalls: erroring };
}

function fingerprintsEqual(
  a: RoundFingerprint | null,
  b: RoundFingerprint | null,
): boolean {
  if (a === null || b === null) return false;
  return (
    a.erroringCalls.length === b.erroringCalls.length &&
    a.erroringCalls.every((v, i) => v === b.erroringCalls[i])
  );
}

/**
 * Stateful tracker bundle. One instance per agent run. Call `observe()` after
 * each step's tool round completes; check `snapshot()` / `tripReason()`.
 */
export class ToolLoopGuard {
  private malformedCount = 0;
  private failureCount = 0;
  private allErrorCount = 0;
  private lastFingerprint: RoundFingerprint | null = null;
  private cycleHistory: RoundFingerprint[] = [];
  private bestCycle: { period: number; repetitions: number } | null = null;
  private tripped: LoopTripReason | null = null;
  private readonly limits: ToolLoopGuardLimits;

  constructor(limits: ToolLoopGuardLimits = DEFAULT_TOOL_LOOP_LIMITS) {
    this.limits = limits;
  }

  /**
   * Record one tool round. Returns the updated snapshot. Once tripped, the
   * guard is latched — further observations are ignored.
   */
  observe(calls: ObservedToolCall[]): ToolLoopSnapshot {
    if (this.tripped) return this.snapshot();

    const executedCalls = calls.filter((c) => !c.malformed);
    const allMalformed = calls.length > 0 && executedCalls.length === 0;
    const allError =
      executedCalls.length > 0 && executedCalls.every((c) => c.error);
    const fingerprint = fingerprintOf(calls);

    // --- Breaker 1: malformed ---
    // Only counts when *every* call was malformed (aionrs feeds the malformed
    // tracker only on rounds where the whole round was malformed).
    this.malformedCount = allMalformed ? this.malformedCount + 1 : 0;

    // --- Breaker 2: identical failing fingerprint ---
    if (fingerprint && fingerprintsEqual(fingerprint, this.lastFingerprint)) {
      this.failureCount += 1;
    } else {
      this.failureCount = fingerprint ? 1 : 0;
      this.lastFingerprint = fingerprint;
    }
    // Reset the "last" pointer when there was nothing failing this round, so a
    // later identical fingerprint restarts the count from 1 (matches aionrs).
    if (fingerprint === null) {
      this.lastFingerprint = null;
    }

    // --- Breaker 3: all-error rounds ---
    this.allErrorCount = allError ? this.allErrorCount + 1 : 0;

    // --- Breaker 4: cycle detection ---
    this.observeCycle(fingerprint);

    // --- Evaluate trip conditions ---
    if (
      this.limits.maxMalformedTurns > 0 &&
      this.malformedCount >= this.limits.maxMalformedTurns
    ) {
      this.trip('malformed');
    } else if (
      this.limits.maxFailureTurns > 0 &&
      this.failureCount >= this.limits.maxFailureTurns
    ) {
      this.trip('failure');
    } else if (
      this.limits.maxAllErrorRounds > 0 &&
      this.allErrorCount >= this.limits.maxAllErrorRounds
    ) {
      this.trip('all_error');
    } else if (
      this.bestCycle &&
      this.limits.maxCycleRepetitions > 0 &&
      this.bestCycle.repetitions >= this.limits.maxCycleRepetitions
    ) {
      this.trip('cycle');
    }

    return this.snapshot();
  }

  private observeCycle(current: RoundFingerprint | null): void {
    if (this.limits.maxCycleRepetitions <= 0) {
      this.cycleHistory = [];
      return;
    }
    if (current === null) {
      this.cycleHistory = [];
      return;
    }
    this.cycleHistory.push(current);
    const maxHistory =
      MAX_TOOL_CALL_CYCLE_PERIOD * this.limits.maxCycleRepetitions;
    while (this.cycleHistory.length > maxHistory) {
      this.cycleHistory.shift();
    }
    this.bestCycle = this.detectCycle();
  }

  /**
   * aionrs algorithm: for each candidate period p in 2..PERIOD, walk backwards
   * counting how many times the trailing p-length pattern repeats. Keep the
   * best (most repetitions, tiebreak shortest period).
   */
  private detectCycle(): { period: number; repetitions: number } | null {
    const n = this.cycleHistory.length;
    const maxPeriod = Math.min(MAX_TOOL_CALL_CYCLE_PERIOD, Math.floor(n / 2));
    let best: { period: number; repetitions: number } | null = null;
    for (let period = 2; period <= maxPeriod; period++) {
      const patternStart = n - period;
      let repetitions = 1;
      let prevEnd = patternStart;
      while (
        prevEnd >= period &&
        fingerprintsEqual(
          this.cycleHistory[prevEnd - period],
          this.cycleHistory[prevEnd],
        ) &&
        // also verify the whole pattern block matches (not just endpoints)
        this.blockEquals(prevEnd - period, prevEnd, period)
      ) {
        repetitions += 1;
        prevEnd -= period;
      }
      if (repetitions < 2) continue;
      const candidate = { period, repetitions };
      if (
        !best ||
        candidate.repetitions > best.repetitions ||
        (candidate.repetitions === best.repetitions &&
          candidate.period < best.period)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  private blockEquals(startA: number, startB: number, len: number): boolean {
    for (let i = 0; i < len; i++) {
      if (
        !fingerprintsEqual(
          this.cycleHistory[startA + i],
          this.cycleHistory[startB + i],
        )
      )
        return false;
    }
    return true;
  }

  private trip(reason: LoopTripReason): void {
    if (this.tripped) return;
    this.tripped = reason;
    logger.warn('tool_loop_guard:tripped', {
      reason,
      malformedCount: this.malformedCount,
      failureCount: this.failureCount,
      allErrorCount: this.allErrorCount,
      cycle: this.bestCycle,
      limits: this.limits,
    });
  }

  snapshot(): ToolLoopSnapshot {
    return {
      malformedCount: this.malformedCount,
      failureCount: this.failureCount,
      allErrorCount: this.allErrorCount,
      cycle: this.bestCycle,
      tripped: this.tripped,
    };
  }

  tripReason(): LoopTripReason | null {
    return this.tripped;
  }
}

/**
 * Build a human-readable abort message for a tripped guard. Surfaced to the
 * user as a streamed error and to the workflow run log.
 */
export function describeLoopTrip(
  reason: LoopTripReason,
  snap: ToolLoopSnapshot,
): string {
  switch (reason) {
    case 'malformed':
      return `智能体连续 ${snap.malformedCount} 轮产出的工具调用均无法解析，已中止以避免空转。请检查工具 schema 或切换模型。`;
    case 'failure':
      return `智能体连续 ${snap.failureCount} 轮以相同参数重复调用失败的工具，已中止以避免空转。`;
    case 'all_error':
      return `智能体连续 ${snap.allErrorCount} 轮工具调用全部失败，已中止以避免空转。`;
    case 'cycle': {
      const c = snap.cycle;
      return c
        ? `智能体陷入周期为 ${c.period}、重复 ${c.repetitions} 次的工具调用循环，已中止以避免空转。`
        : '智能体陷入工具调用循环，已中止以避免空转。';
    }
  }
}

/**
 * Stable string key for a tool call's input. Used for fingerprinting. We do a
 * best-effort canonical JSON (sorted object keys) so input field ordering does
 * not fragment the fingerprint. Non-serializable inputs fall back to String().
 */
export function inputKeyOf(input: unknown): string {
  if (input === null || input === undefined) return '';
  try {
    return stableJsonStringify(input);
  } catch {
    return String(input);
  }
}

function stableJsonStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}
