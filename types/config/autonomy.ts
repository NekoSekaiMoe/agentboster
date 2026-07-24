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
 * Microcompact config (borrowed from aionrs compact/micro.rs).
 *
 * The lightest compaction tier: folds the content of old tool-result parts
 * into a placeholder without an LLM call, keeping the N most recent intact.
 * Runs in prepareStep before the autocompact threshold check, so the
 * heavier LLM-summary compaction only fires when this pass alone isn't
 * enough to bring the prompt back under budget.
 */
export const microcompactConfigSchema = z.object({
  /** Master switch. Default enabled. */
  enabled: z.boolean().optional(),
  /** Keep the N most-recent compactable results intact; fold older. */
  keep_recent: z.number().int().min(1).optional(),
  /** Tool names whose results are eligible for folding. */
  compactable_tools: z.array(z.string()).optional(),
  /** Run only when live compactable results exceed this count. */
  min_results_to_trigger: z.number().int().min(0).optional(),
});

export type MicrocompactConfigOverrides = z.infer<
  typeof microcompactConfigSchema
>;

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
   * YOLO / full-auto toggle (borrowed from AionUi's per-agent YOLO switch).
   * When true, ALL three security tiers (L0 blocklist / L1 scoring / L2
   * approval) are short-circuited for non-destructive tools and the agent
   * runs without confirmation prompts. Destructive commands (rm -rf, drop,
   * format) still force L2 regardless. Off by default — this is strictly
   * opt-in and the UI surfaces a warning when enabled.
   */
  yolo: z.boolean().default(false).optional(),
  /**
   * Team Leader mode (Team Mode III). Injects prompt-level guidance that
   * coaches the main agent to decompose complex tasks into a subAgent
   * fan-out plan and coordinate it via barriers/handoffs. The agent already
   * has those tools; this just makes it actually use them for multi-step
   * work instead of running everything inline. Off by default.
   */
  team_leader: z.boolean().default(false).optional(),
  /**
   * Tool-loop circuit-breaker overrides. When omitted the defaults from
   * `tool-loop-guard.ts` apply (3/3/8/3). Set a field to 0 to disable that
   * specific breaker.
   */
  tool_loop_limits: toolLoopLimitsSchema.optional(),
  /**
   * Microcompact overrides (aionrs compact/micro.rs). Folds old tool-result
   * content into a placeholder without an LLM call, before the autocompact
   * threshold check. See `lib/workflow/agent/microcompact.ts`.
   */
  microcompact: microcompactConfigSchema.optional(),
});

export type AutonomyConfig = z.infer<typeof autonomyConfigSchema>;
