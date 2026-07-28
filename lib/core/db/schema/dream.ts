import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Audit row for each Dream run (one user, one invocation).
 *
 * Persists the full operation list proposed by Phase 1/2 and what got
 * applied, so a reviewer (or the user) can answer "why does this memory
 * exist?" by reading the `operations` + `result` jsonb. Mirrors AutoGPT's
 * approach of recording provenance on durable rows rather than in logs.
 *
 * Read-only after insertion — no status machine here. Failed runs still
 * record a row with `result.apply.failed > 0` so partial progress is
 * auditable.
 */
export const dreamRuns = pgTable(
  'dream_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** User whose memories were consolidated. */
    userId: text('user_id').notNull(),
    /** When this run started (UTC). */
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** When this run finished (UTC). null = still running / crashed. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Phase(s) that ran, e.g. "phase1", "phase1+phase2+phase3". */
    phases: text('phases').notNull(),
    /**
     * Full sanitized operation list that apply.ts consumed. Stored so the
     * exact mutations of a run are reconstructable for audit/debug.
     *
     * NOTE: on early/crashed runs the orchestrator's finally path writes
     * an empty placeholder here; full provenance for completed runs is
     * recorded in `result` (phase stats, counts). Treat this column as
     * best-effort per-run detail rather than a guaranteed-complete
     * operation log.
     */
    operations: jsonb('operations').$type<unknown[]>().notNull(),
    /** Aggregate stats from phase1/3 + apply. */
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Mirrors the index declared in migration 0028_dream_runs.sql so the
    // schema definition and the DB stay in sync. Backs the "recent runs
    // per user" query (filter by userId, order by startedAt).
    index('dream_runs_user_started_idx').on(table.userId, table.startedAt),
  ],
);

/** TypeScript-side row type for `dream_runs`. */
export type DreamRun = typeof dreamRuns.$inferSelect;
