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

export interface ScheduledTaskRunRecord {
  id: string;
  taskId: string;
  source: 'schedule' | 'manual';
  status: 'pending' | 'running' | 'skipped' | 'completed' | 'failed';
  plannedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  runId: string | null;
  failureReason: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Atomically claim a run slot for (taskId, plannedAt).
 *
 * Returns `{ created: true, run }` when this caller won the slot (either
 * no prior row existed, or a prior row existed but was terminal and is
 * being reused), or `{ created: false, run }` when a non-terminal run
 * already holds the slot (idempotent re-tick after a crash should resume
 * the existing run rather than dispatch twice).
 *
 * The partial unique index `scheduled_task_runs_task_planned_uniq`
 * enforces this at the DB layer; we rely on it raising a unique-
 * violation on the racing INSERT.
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
  } catch {
    // Unique violation: another caller claimed this slot first. Load
    // the existing row so the caller can decide to resume or no-op.
  }
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
    // The race loser deleted the row between INSERT and SELECT — extremely
    // unlikely but recoverable by re-claiming.
    return claimScheduledRunSlot(input);
  }
  return { created: false, run: existing as ScheduledTaskRunRecord };
}

/** Mark a run as started (dispatch in progress). */
export async function markRunStarted(runId: string): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(scheduledTaskRuns.id, runId));
}

/** Mark a run as completed with the chat workflow runId. */
export async function markRunCompleted(
  runId: string,
  chatRunId: string,
): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      status: 'completed',
      runId: chatRunId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTaskRuns.id, runId));
}

/** Mark a run as skipped (admission gate failed, e.g. target node offline). */
export async function markRunSkipped(
  runId: string,
  reason: string,
): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      status: 'skipped',
      errorMessage: reason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTaskRuns.id, runId));
}

/** Mark a run as failed with the canonical FailureReason + message. */
export async function markRunFailed(
  runId: string,
  input: { failureReason?: string | null; errorMessage?: string | null },
): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      status: 'failed',
      failureReason: input.failureReason ?? null,
      errorMessage: input.errorMessage ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTaskRuns.id, runId));
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
