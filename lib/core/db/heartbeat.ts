import { db, schema } from '@/lib/core/db';
import { createLogger } from '@/lib/utils/logger';
import { and, eq, isNotNull, lte } from 'drizzle-orm';

const logger = createLogger('db.heartbeat');

/** Clamp bounds for heartbeat intervals (anti-spam floor, sanity ceiling). */
export const HEARTBEAT_MIN_INTERVAL_MINUTES = 5;
export const HEARTBEAT_MAX_INTERVAL_MINUTES = 1440;
export const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 30;

export function clampHeartbeatIntervalMinutes(
  raw: number | undefined | null,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return HEARTBEAT_DEFAULT_INTERVAL_MINUTES;
  }
  const rounded = Math.round(raw);
  return Math.min(
    HEARTBEAT_MAX_INTERVAL_MINUTES,
    Math.max(HEARTBEAT_MIN_INTERVAL_MINUTES, rounded),
  );
}

/** Upsert the per-session heartbeat configuration. */
export async function upsertSessionHeartbeat(input: {
  sessionId: string;
  enabled: boolean;
  intervalMinutes?: number;
}): Promise<schema.SessionHeartbeat> {
  const intervalMinutes = clampHeartbeatIntervalMinutes(input.intervalMinutes);
  const nextRunAt = input.enabled
    ? new Date(Date.now() + intervalMinutes * 60_000)
    : null;

  const [row] = await db
    .insert(schema.sessionHeartbeats)
    .values({
      sessionId: input.sessionId,
      enabled: input.enabled,
      intervalMinutes,
      nextRunAt,
      // Re-enabling resets the failure budget (mirrors scheduled_tasks).
      ...(input.enabled ? { failureCount: 0 } : {}),
    })
    .onConflictDoUpdate({
      target: schema.sessionHeartbeats.sessionId,
      set: {
        enabled: input.enabled,
        intervalMinutes,
        nextRunAt,
        updatedAt: new Date(),
        ...(input.enabled ? { failureCount: 0 } : {}),
      },
    })
    .returning();

  if (!row) {
    throw new Error('Failed to upsert session heartbeat.');
  }
  logger.info('upsert:success', {
    sessionId: input.sessionId,
    enabled: input.enabled,
    intervalMinutes,
  });
  return row;
}

export async function getSessionHeartbeat(sessionId: string) {
  const [row] = await db
    .select()
    .from(schema.sessionHeartbeats)
    .where(eq(schema.sessionHeartbeats.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically claim the next due wake-up slot for a session.
 *
 * Single-statement CAS: the UPDATE only fires when the row is enabled and
 * `next_run_at` is due, and it ADVANCES `next_run_at` in the same
 * statement — concurrent ticks cannot both win (the loser's WHERE clause
 * no longer matches). Advance-on-dispatch (not advance-on-completion) is
 * deliberate: a slow or failed run must not double-fire its own slot.
 *
 * Returns null when there is nothing to claim (disabled, not yet due, or
 * no row at all) — callers treat that as "not ours to dispatch".
 */
export async function claimDueHeartbeat(input: {
  sessionId: string;
  now?: Date;
}): Promise<schema.SessionHeartbeat | null> {
  const now = input.now ?? new Date();
  // Single-statement CAS. The WHERE only matches when the row is enabled
  // and next_run_at is due, and next_run_at ADVANCES in the same statement
  // — concurrent ticks cannot both win (the loser's WHERE no longer
  // matches). Advance-on-dispatch (not on-completion) is deliberate: a
  // slow or failed run must not double-fire its own slot. Raw SQL because
  // drizzle's set() cannot reference the row's own interval_minutes.
  const { sql } = await import('drizzle-orm');
  const result = await db.execute(sql`
    UPDATE session_heartbeats
       SET last_run_at = ${now},
           next_run_at = ${now}::timestamptz + (interval_minutes * interval '1 minute'),
           updated_at = ${now}
     WHERE session_id = ${input.sessionId}
       AND enabled = true
       AND next_run_at IS NOT NULL
       AND next_run_at <= ${now}
    RETURNING session_id, enabled, interval_minutes, next_run_at, last_run_at
  `);
  // drizzle's execute() unwraps .rows for both neon-http and node-postgres.
  const rows = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Array<{
    session_id: string;
    enabled: boolean;
    interval_minutes: number;
    next_run_at: Date | string | null;
    last_run_at: Date | string | null;
  }>;
  const claimed = rows[0];
  if (!claimed) return null;

  logger.info('claim:success', {
    sessionId: input.sessionId,
    nextRunAt: claimed.next_run_at
      ? new Date(claimed.next_run_at).toISOString()
      : null,
  });
  return {
    sessionId: claimed.session_id,
    enabled: claimed.enabled,
    intervalMinutes: claimed.interval_minutes,
    nextRunAt: claimed.next_run_at ? new Date(claimed.next_run_at) : null,
    lastRunAt: claimed.last_run_at ? new Date(claimed.last_run_at) : null,
  } as schema.SessionHeartbeat;
}

/**
 * List every enabled heartbeat whose next_run_at is due — used by the
 * lazy sweeper (belt-and-braces behind the sleeping wake workflow) and
 * by ops/tooling surfaces.
 */
export async function listDueSessionHeartbeats(now = new Date()) {
  return db
    .select()
    .from(schema.sessionHeartbeats)
    .where(
      and(
        eq(schema.sessionHeartbeats.enabled, true),
        isNotNull(schema.sessionHeartbeats.nextRunAt),
        lte(schema.sessionHeartbeats.nextRunAt, now),
      ),
    );
}

/** Record the outcome of a dispatched heartbeat run. */
export async function recordHeartbeatResult(input: {
  sessionId: string;
  reply: boolean;
  chatRunId?: string | null;
  failed?: boolean;
}) {
  const { sql } = await import('drizzle-orm');
  const now = new Date();
  const [row] = await db
    .update(schema.sessionHeartbeats)
    .set({
      lastDecisionAt: now,
      lastDecisionReply: input.reply,
      lastChatRunId: input.chatRunId ?? null,
      // SQL-side increment/reset — a read-then-write would lose updates
      // under concurrent dispatches of the same session.
      failureCount: input.failed
        ? sql`${schema.sessionHeartbeats.failureCount} + 1`
        : sql`0`,
      updatedAt: now,
    })
    .where(eq(schema.sessionHeartbeats.sessionId, input.sessionId))
    .returning();
  return row ?? null;
}

/** Track the sleeping wake-workflow run id for this heartbeat. */
export async function setHeartbeatWorkflowRunId(
  sessionId: string,
  workflowRunId: string | null,
) {
  await db
    .update(schema.sessionHeartbeats)
    .set({ heartbeatWorkflowRunId: workflowRunId, updatedAt: new Date() })
    .where(eq(schema.sessionHeartbeats.sessionId, sessionId));
}
