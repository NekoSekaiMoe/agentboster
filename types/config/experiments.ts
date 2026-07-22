import { z } from 'zod';

/**
 * Experimental features. Each flag defaults to off and lives behind a
 * settings toggle. Features here are either in development, waiting for
 * broader validation, or deliberately opt-in because they consume extra
 * LLM tokens or surface auto-generated artifacts the user may want to
 * review first.
 *
 * When a feature stabilizes it should be promoted out of this schema
 * into a first-class config domain.
 */

/**
 * Non-optional shape. `AppConfig` wraps this with `.optional()` so the
 * whole section can be absent, but keeping the inner type union-free
 * lets forms index into it (`ExperimentsConfig['skillDistillation']`)
 * without fighting `| undefined` on every access.
 */
export const experimentsConfigShapeSchema = z.object({
  /**
   * Skill distillation loop.
   *
   * After a conversation with enough tool-call density closes, a
   * background reviewer scans the transcript and decides whether the
   * workflow just executed is worth turning into a reusable skill.
   * When enabled, it runs as an `afterResponse` callback (same
   * best-effort channel as memory extraction) and stages any proposal
   * as a draft skill on the Skills page — never auto-activated.
   *
   * Off by default: it spends one extra LLM call per qualifying
   * session and produces auto-generated artifacts that the user is
   * expected to review.
   */
  skillDistillation: z
    .object({
      /** Master switch. */
      enabled: z.boolean().default(false),
      /**
       * Minimum tool-call count in a single conversation required to
       * trigger the reviewer. Below this the session is treated as
       * chit-chat / trivial and skipped (no extra LLM call).
       * Mirrors Hermes' `_skill_nudge_interval` idea but counts calls
       * rather than model iterations, since AgentBoster's loop is
       * structured around tool dispatches.
       */
      toolCallThreshold: z.number().int().min(3).default(8),
      /**
       * Before self-authoring a SKILL.md, search the ClawHub skill
       * hub for an existing skill covering the same capability. If a
       * high-scoring match exists, stage an "install suggestion" draft
       * instead of generating content from scratch — reusing the
       * community skill is usually better than a model's first guess.
       */
      preferClawHub: z.boolean().default(true),
      /**
       * Minimum normalized ClawHub search score to accept a suggestion
       * automatically. The `/api/search` endpoint returns scores that
       * are roughly TF-IDF-ish; empirically values below ~1.0 are weak
       * matches. Keep conservative so we don't spam the user with
       * barely-relevant install prompts.
       */
      clawhubMinScore: z.number().min(0).default(1.5),
      /**
       * Minimum hours between curator passes. The curator piggybacks on
       * distill triggers (no standalone scheduler on serverless), reviewing
       * draft skills and auto-archiving low-signal ones so the Skills-page
       * review queue stays manageable. Lower = tidier queue (more LLM
       * calls); higher = hands-off. Set to 0 to disable curator entirely.
       */
      curatorIntervalHours: z.number().min(0).default(6),
    })
    .optional(),
});

export type ExperimentsConfigShape = z.infer<
  typeof experimentsConfigShapeSchema
>;

export const experimentsConfigSchema = experimentsConfigShapeSchema;

export type ExperimentsConfig = ExperimentsConfigShape;
