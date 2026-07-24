import { z } from 'zod';

export const autonomyLevelEnum = z.enum([
  'supervised', // Supervised autonomy; critical actions require confirmation.
  'full', // Fully autonomous.
]);

export type AutonomyLevel = z.infer<typeof autonomyLevelEnum>;

/**
 * Tool-loop circuit-breaker limits.
 *
 * Borrowed from aionrs (`crates/aion-agent/src/tool_call.rs`): the agent step
 * loop can get stuck retrying the same failing tool call, oscillating in a
 * A→B→A→B cycle, or emitting unparsable calls. Without breakers the run
 * burns API credit up to `max_steps` (default 20-30) of identical failures.
 *
 * Each limit is the consecutive-round count that trips that breaker;
 * 0 disables it. All optional — absent fields fall back to the defaults
 * in `lib/workflow/agent/tool-loop-guard.ts` (3/3/8/3, matching aionrs).
 */
export const toolLoopLimitsSchema = z.object({
  /** Consecutive rounds where every tool call was structurally invalid. */
  max_malformed_turns: z.number().int().min(0).optional(),
  /** Consecutive rounds with the same failing tool-call fingerprint. */
  max_failure_turns: z.number().int().min(0).optional(),
  /** Consecutive rounds in which every executed tool returned an error. */
  max_all_error_rounds: z.number().int().min(0).optional(),
  /** Repetition count at which a periodic tool-call cycle trips. */
  max_cycle_repetitions: z.number().int().min(0).optional(),
});

export type ToolLoopLimitsConfig = z.infer<typeof toolLoopLimitsSchema>;

/**
 * Autonomy configuration schema.
 */
export const autonomyConfigSchema = z.object({
  /** Autonomy level. */
  level: autonomyLevelEnum.default('supervised'),
  /** Max number of actions allowed per conversation. */
  max_steps: z
    .number()
    .int()
    .min(0, 'max_steps cannot be negative')
    .default(20),
  /**
   * Tool-loop circuit-breaker overrides. When omitted the defaults from
   * `tool-loop-guard.ts` apply (3/3/8/3). Set a field to 0 to disable that
   * specific breaker.
   */
  tool_loop_limits: toolLoopLimitsSchema.optional(),
});

export type AutonomyConfig = z.infer<typeof autonomyConfigSchema>;
