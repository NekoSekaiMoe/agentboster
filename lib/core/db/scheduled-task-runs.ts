import { and, desc, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm';
import { db } from './index';
import { scheduledTaskRuns } from './schema';

/**
 * DAL for scheduled_task_runs — the per-fire history table that gives
 * scheduled tasks an autopilot_run-style audit trail (ported from
 * Multica migration 042 + 124).
 *
 * The {@link claimScheduledRunSlot} helper is the idempotency primitive:
 * it INSERTs a row with status='pending' and returns whether THIS caller
 * won the slot. Two concurrent claims for the same (taskId, plannedAt)
 * cannot both succeed — the partial unique index rejects the second.
 */

/**
 * Postgres throws SQLSTATE 23505 for unique-index violations. Both the
 * node-postgres and neon-http drivers surface it as `error.code`.
 */
function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code === '23505';
}

export interface ScheduledTaskRunRecord {
  id: string;
  taskId: string;
  source: 'schedule' | 'manual';
  status: 'pending' | 'running' | 'skipped' | 'completed' | 'failed';
  plannedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  heartbeatAt: Date | null;
  runId: string | null;
  failureReason: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Atomically claim a run slot for (taskId, plannedAt).
 *
 * Returns `{ created: true, run }` when this caller won the slot — either
 * no prior row existed, OR a prior row existed but was TERMINAL
 * (completed/failed/skipped) and this call atomically reset it to
 * `pending` for re-dispatch. Returns `{ created: false, run }` when a
 * non-terminal run (pending/running) already holds the slot — the
 * caller should treat this as a duplicate/no-op.
 *
 * This is the idempotency primitive: two concurrent ticks for the same
 * slot cannot both win. The implementation handles the three cases:
 *
 *   1. No row exists            → INSERT succeeds → created=true.
 *   2. Terminal row exists      → atomic UPDATE resets it to pending →
 *                                 created=true (the prior run is archived).
 *   3. Non-terminal row exists  → SELECT returns it → created=false.
 *
 * The partial unique index `scheduled_task_runs_task_planned_uniq` keeps
 * case 1 race-safe (one INSERT wins, the other unique-violates and
 * falls through to 2 or 3). The CAS in case 2 (`WHERE status IN
 * (terminal states)`) prevents a non-terminal row from being reset by
 * a concurrent reaper-like caller.
 *
 * Case 2 is the recovery path for crashed dispatches: a prior run that
 * crashed mid-flight stays `pending`/`running` (reaped separately by
 * {@link reapStuckRuns}); a prior run that completed/failed/skipped can
 * be legitimately re-dispatched when the schedule rolls around again
 * next day with the same plannedAt (should not happen under the
 * `sameInstant` fast-path, but the DB-level guard is authoritative).
 */
export async function claimScheduledRunSlot(input: {
  taskId: string;
  plannedAt: Date;
  source?: 'schedule' | 'manual';
}): Promise<{ created: boolean; run: ScheduledTaskRunRecord }> {
  const source = input.source ?? 'schedule';
  try {
    const [row] = await db
      .insert(scheduledTaskRuns)
      .values({
        taskId: input.taskId,
        plannedAt: input.plannedAt,
        source,
        status: 'pending',
      })
      .returning();
    return { created: true, run: row as ScheduledTaskRunRecord };
  } catch (error) {
    // Only treat Postgres unique-violation (SQLSTATE 23505) as the
    // "slot already exists, fall through to reuse/non-terminal logic"
    // signal. Every other error (connection drop, serialization failure,
    // permission, etc.) must propagate so it is not silently masked as
    // { created: true }.
    if (!isPgUniqueViolation(error)) throw error;
  }

  // Try to atomically reset a TERMINAL row to pending (case 2). The CAS
  // WHERE clause prevents resetting a live pending/running row.
  const [reused] = await db
    .update(scheduledTaskRuns)
    .set({
      status: 'pending',
      source,
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      runId: null,
      failureReason: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTaskRuns.taskId, input.taskId),
        eq(scheduledTaskRuns.plannedAt, input.plannedAt),
        sql`${scheduledTaskRuns.status} IN ('completed', 'failed', 'skipped')`,
      ),
    )
    .returning();
  if (reused) {
    return { created: true, run: reused as ScheduledTaskRunRecord };
  }

  // Case 3: a non-terminal row holds the slot. Return it so the caller
  // treats the slot as taken (idempotent re-tick / duplicate).
  const [existing] = await db
    .select()
    .from(scheduledTaskRuns)
    .where(
      and(
        eq(scheduledTaskRuns.taskId, input.taskId),
        eq(scheduledTaskRuns.plannedAt, input.plannedAt),
      ),
    )
    .limit(1);
  if (!existing) {
    // Row vanished between the INSERT violation and this SELECT — retry.
    return claimScheduledRunSlot(input);
  }
  return { created: false, run: existing as ScheduledTaskRunRecord };
}

/** Mark a run as started (dispatch in progress). */
export async function markRunStarted(runId: string): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      status: 'running',
      startedAt: new Date(),
      // Start the heartbeat lease clock at dispatch-begin so the reaper
      // has a fresh timestamp before the first interval tick fires
      // (closes the window between markRunStarted and the first
      // setInterval fire in the dispatch loop).
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTaskRuns.id, runId));
}

/**
 * Refresh the heartbeat lease on a run. Called periodically by the
 * dispatch while a long-running workflow is in flight so the reaper
 * can distinguish a live long run from a truly stuck one. Best-effort:
 * a transient DB blip on a heartbeat tick should not fail the dispatch.
 */
export async function markRunHeartbeat(runId: string): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
      ),
    );
}

/**
 * Mark a run as completed with the chat workflow runId. Returns false
 * (no row updated) if the run is no longer in a non-terminal state —
 * e.g. the reaper already flipped it to `failed`+`runtime_recovery`,
 * in which case we must NOT clobber that with `completed`.
 */
export async function markRunCompleted(
  runId: string,
  chatRunId: string,
): Promise<boolean> {
  const updated = await db
    .update(scheduledTaskRuns)
    .set({
      status: 'completed',
      runId: chatRunId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
      ),
    )
    .returning({ id: scheduledTaskRuns.id });
  return updated.length > 0;
}

/**
 * Mark a run as skipped (admission gate failed, e.g. target node
 * offline). Status CAS prevents a late skip from overwriting a run
 * the reaper (or another caller) already moved to a terminal state.
 */
export async function markRunSkipped(
  runId: string,
  reason: string,
): Promise<boolean> {
  const updated = await db
    .update(scheduledTaskRuns)
    .set({
      status: 'skipped',
      errorMessage: reason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
      ),
    )
    .returning({ id: scheduledTaskRuns.id });
  return updated.length > 0;
}

/**
 * Mark a run as failed with the canonical FailureReason + message.
 * Status CAS prevents a late failure mark from overwriting a run
 * that was already moved to a terminal state by the reaper or a
 * concurrent caller.
 */
export async function markRunFailed(
  runId: string,
  input: { failureReason?: string | null; errorMessage?: string | null },
): Promise<boolean> {
  const updated = await db
    .update(scheduledTaskRuns)
    .set({
      status: 'failed',
      failureReason: input.failureReason ?? null,
      errorMessage: input.errorMessage ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
      ),
    )
    .returning({ id: scheduledTaskRuns.id });
  return updated.length > 0;
}

/**
 * Recent runs for a task, newest first. Used by the task-detail UI.
 */
export async function listRecentRunsForTask(
  taskId: string,
  limit = 20,
): Promise<ScheduledTaskRunRecord[]> {
  const rows = await db
    .select(getTableColumns(scheduledTaskRuns))
    .from(scheduledTaskRuns)
    .where(eq(scheduledTaskRuns.taskId, taskId))
    .orderBy(desc(scheduledTaskRuns.plannedAt))
    .limit(limit);
  return rows as ScheduledTaskRunRecord[];
}

/**
 * Count non-terminal runs for a task — used by the admission gate to
 * detect "a dispatch is already in flight for this task" (coalesce).
 */
export async function countActiveRunsForTask(taskId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledTaskRuns)
    .where(
      and(
        eq(scheduledTaskRuns.taskId, taskId),
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
      ),
    );
  return row?.n ?? 0;
}

/** Run history for a user (via join on scheduled_tasks.sessionId → userId). */
export async function listRecentRunsWherePlannedAtNotNull(
  limit = 100,
): Promise<ScheduledTaskRunRecord[]> {
  const rows = await db
    .select(getTableColumns(scheduledTaskRuns))
    .from(scheduledTaskRuns)
    .where(isNotNull(scheduledTaskRuns.plannedAt))
    .orderBy(desc(scheduledTaskRuns.plannedAt))
    .limit(limit);
  return rows as ScheduledTaskRunRecord[];
}

/**
 * Reap stuck runs: flip `pending`/`running` rows whose `startedAt` (or
 * `plannedAt` when `startedAt` is null) is older than `staleMs` to
 * `failed` with `runtime_recovery`. Returns the count of reaped rows.
 *
 * A run gets stuck when the dispatch process dies between
 * `claimScheduledRunSlot` and the terminal `markRun*` call (OOM, lambda
 * timeout, deploy mid-flight). Without a reaper the row stays
 * non-terminal forever and — because `claimScheduledRunSlot` only
 * reuses terminal rows — that `plannedAt` slot can never re-run.
 *
 * Piggyback this on any periodic beat (cron tick, heartbeat). The
 * returned count lets callers log/metric reaped-stuck-runs without
 * surfacing the rows themselves. Default stale threshold is 15 minutes.
 */
export async function reapStuckRuns(
  // 15 minutes. The dispatch refreshes heartbeatAt every ~30s while a
  // workflow is in flight (see deliverScheduledTask in dispatch.ts), so
  // 15min is well above the heartbeat interval and gives ample buffer
  // for transient DB blips, GC pauses, and clock skew. A live
  // long-running dispatch heartbeats far more frequently than this; a
  // run that hasn't heartbeat-ed in 15min is truly stuck (process died
  // between markRunStarted and the terminal markRun* call — OOM, lambda
  // timeout, deploy mid-flight). COALESCE falls back to startedAt /
  // plannedAt / createdAt so rows written before heartbeatAt existed
  // (or that crashed before markRunStarted stamped the first heartbeat)
  // still reaped correctly.
  staleMs = 15 * 60 * 1000,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  // A row is stuck when it's non-terminal AND its heartbeatAt (or, for
  // rows without a heartbeat, startedAt / plannedAt) is older than the
  // cutoff. The coalesce falls back heartbeatAt → startedAt →
  // plannedAt → createdAt so a row that crashed before markRunStarted
  // still gets reaped, and legacy rows written before the heartbeat
  // column existed keep reaping under the old startedAt-based rule.
  const reaped = await db
    .update(scheduledTaskRuns)
    .set({
      status: 'failed',
      failureReason: 'runtime_recovery',
      errorMessage: 'run reaped: stuck in pending/running past stale threshold',
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        sql`${scheduledTaskRuns.status} IN ('pending', 'running')`,
        sql`COALESCE(${scheduledTaskRuns.heartbeatAt}, ${scheduledTaskRuns.startedAt}, ${scheduledTaskRuns.plannedAt}, ${scheduledTaskRuns.createdAt}) < ${cutoff}`,
      ),
    )
    .returning({ id: scheduledTaskRuns.id });
  return reaped.length;
}
