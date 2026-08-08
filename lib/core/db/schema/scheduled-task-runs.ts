import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * One execution of a scheduled task.
 *
 * Ported from Multica's `autopilot_run` (migration 042 + 124's unique
 * index). Until this table existed, agentboster tracked scheduled-task
 * history only as scalars on `scheduled_tasks` (`lastTriggeredAt`,
 * `lastFiredFor`, `failureCount`) — no per-run record survived, so
 * operators couldn't answer "what happened on Tuesday's 9am run?" and
 * races could double-fire the same slot.
 *
 * The `(taskId, plannedAt) WHERE plannedAt IS NOT NULL` partial unique
 * index is the idempotency key: a re-tick after a crash either reuses
 * the existing run row or starts a fresh one, but two concurrent ticks
 * for the same slot cannot both succeed. This mirrors Multica's
 * `uq_autopilot_run_trigger_planned` (migration 124) — the exact lesson
 * that motivated it (crash-recovery double-dispatch) applies unchanged.
 *
 * `source` distinguishes the natural schedule fire from a manual
 * "run-now" button; `status` adds `skipped` for the admission-gate
 * case (target node offline → skip-with-reason instead of burning the
 * failure counter). `failureReason` carries the canonical
 * {@link FailureReason} taxonomy value when status='failed'.
 */
export const scheduledTaskRuns = pgTable(
  'scheduled_task_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    /** 'schedule' (cron/timer fire) or 'manual' (user pressed run-now). */
    source: text('source', { enum: ['schedule', 'manual'] })
      .default('schedule')
      .notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'skipped', 'completed', 'failed'],
    })
      .default('pending')
      .notNull(),
    /**
     * The slot this run fires for (ISO timestamp). The partial unique
     * index on (taskId, plannedAt) makes this the idempotency key.
     */
    plannedAt: timestamp('planned_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Heartbeat lease timestamp refreshed periodically by the dispatch
     * while a long-running workflow is in flight. The reaper keys off
     * COALESCE(heartbeatAt, startedAt, plannedAt, createdAt) so a run
     * that stops heartbeating past the stale threshold is flipped to
     * `failed`+`runtime_recovery`. Null for rows written before this
     * column existed (legacy fallback to startedAt).
     */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** The chat workflow runId produced by this fire (on success). */
    runId: text('run_id'),
    /** Canonical FailureReason when status='failed'; null otherwise. */
    failureReason: text('failure_reason'),
    /** Free-text error detail when status='failed' or 'skipped'. */
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    taskPlannedIdx: index('scheduled_task_runs_task_planned_idx').on(
      table.taskId,
      table.plannedAt,
    ),
    taskStatusIdx: index('scheduled_task_runs_task_status_idx').on(
      table.taskId,
      table.status,
    ),
    // Idempotency key: one run per (task, planned-slot). Partial so
    // manual runs (plannedAt IS NULL) don't collide.
    taskPlannedUniqueIdx: uniqueIndex('scheduled_task_runs_task_planned_uniq')
      .on(table.taskId, table.plannedAt)
      .where(sql`${table.plannedAt} IS NOT NULL`),
  }),
);
