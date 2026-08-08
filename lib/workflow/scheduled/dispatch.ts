import { chatMain } from '@/lib/chat/index';
import { getSession } from '@/lib/core/db/chat';
import { getScheduledTask, updateScheduledTask } from '@/lib/core/db/scheduled';
import {
  claimScheduledRunSlot,
  markRunCompleted,
  markRunFailed,
  markRunHeartbeat,
  markRunSkipped,
  markRunStarted,
} from '@/lib/core/db/scheduled-task-runs';
import { classifyFailure } from '@/lib/core/task/failure-reason';
import { createLogger } from '@/lib/utils/logger';
import { sameInstant } from './utils';
import {
  resolveScheduledTaskUserId,
  sendScheduledTaskCompletion,
} from './notify';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('workflow.scheduled.dispatch');

/** Consecutive failures after which a task is auto-disabled. */
export const MAX_SCHEDULE_FAILURES = 3;

interface NodeRow {
  nodeID: string;
  ip: string;
  port: number;
}

/**
 * Build the chat source for a scheduled dispatch by reusing the task's
 * attached session. (…) same semantics as before.
 */
async function buildScheduledSource(
  sessionId: string,
): Promise<ChatSource | null> {
  const session = await getSession(sessionId);
  if (!session) {
    return null;
  }

  const userId = session.userId ?? null;

  if (session.channel === 'web' && userId) {
    return { type: 'web', userId };
  }

  if (session.channel.startsWith('cli:') && userId) {
    return {
      type: 'cli',
      clientId: session.channel.slice('cli:'.length),
      userId,
      label: session.title ?? null,
    };
  }

  return { type: 'scheduled' };
}

/**
 * Resolve the agentd node to use for this dispatch, given the task's
 * node-routing preferences. Returns:
 *  - `{ node }` when a usable node is found (preferred node reachable,
 *    or auto-fallback found a reachable candidate).
 *  - `{ failed: true, reason }` when the task cannot be dispatched
 *    because the preferred node is unreachable and no fallback is
 *    available. The caller treats this as a dispatch failure.
 *
 * Tasks with no preferredNodeId return `{ node: null }` — the
 * dispatch path falls through to its historical behavior (auto-pick
 * via selectBestNode inside execToolOnAgentd).
 */
async function resolveDispatchNode(input: {
  preferredNodeId: string | null;
  allowedNodes: string[] | null;
  autoFallbackNode: boolean;
}): Promise<{ node: NodeRow | null } | { failed: true; reason: string }> {
  if (!input.preferredNodeId) {
    return { node: null };
  }

  // Look up the preferred node's connection info.
  const { db } = await import('@/lib/core/db');
  const { agentdNodes } = await import('@/lib/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const { checkAgentdHealth } = await import(
    '@/lib/extra/agent/agentd-tools-client'
  );

  const preferredRow = await db
    .select({
      nodeID: agentdNodes.nodeID,
      ip: agentdNodes.ip,
      port: agentdNodes.port,
    })
    .from(agentdNodes)
    .where(eq(agentdNodes.nodeID, input.preferredNodeId))
    .limit(1);

  const preferred =
    preferredRow.length > 0 ? (preferredRow[0] as NodeRow) : null;

  if (preferred && (await checkAgentdHealth(preferred))) {
    return { node: preferred };
  }

  // Preferred node unreachable (or unknown). Decide fallback.
  if (!input.autoFallbackNode) {
    return {
      failed: true,
      reason: `Preferred node ${input.preferredNodeId} is unreachable and auto-fallback is disabled.`,
    };
  }

  const candidates = (input.allowedNodes ?? []).filter(
    (id) => id !== input.preferredNodeId,
  );
  if (candidates.length === 0) {
    return {
      failed: true,
      reason: `Preferred node ${input.preferredNodeId} is unreachable and no fallback candidates are configured.`,
    };
  }

  // Look up ALL fallback candidates in one query so we can probe them
  // in the order they appear in the allowlist. The previous form used
  // `eq(agentdNodes.nodeID, candidates[0])`, which only loaded the
  // first candidate — the loop then `continue`d past every other id
  // (no matching row) and the fallback path was effectively dead.
  const { inArray } = await import('drizzle-orm');
  const candidateRows = await db
    .select({
      nodeID: agentdNodes.nodeID,
      ip: agentdNodes.ip,
      port: agentdNodes.port,
    })
    .from(agentdNodes)
    .where(inArray(agentdNodes.nodeID, candidates));
  // Iterate in allowlist order (NOT row order) so the user's expressed
  // preference is honored — first reachable candidate wins.
  for (const candidateId of candidates) {
    const match = candidateRows.find((r) => r.nodeID === candidateId);
    if (!match) continue;
    const candidate: NodeRow = {
      nodeID: match.nodeID,
      ip: match.ip,
      port: match.port,
    };
    if (await checkAgentdHealth(candidate)) {
      return { node: candidate };
    }
  }

  return {
    failed: true,
    reason: `Preferred node ${input.preferredNodeId} and all fallback candidates are unreachable.`,
  };
}

/**
 * Stash the resolved node constraint on the session metadata so the
 * main agent's tool layer (execToolOnAgentd) picks it up. The tool
 * layer reads `metadata.scheduleNodeConstraints` and intersects it
 * with the agent's `allowed_nodes` config.
 *
 * ## Why token + SQL-level CAS
 *
 * A previous implementation snapshotted the entire `session.metadata`
 * field before writing the constraint, then restored the snapshot in
 * a `finally` after the dispatch run. That raced under concurrent
 * dispatches of the same session:
 *
 *   t0: A reads metadata (empty), writes {scn: A}
 *   t1: B reads metadata ({scn: A}), writes {scn: B}  (A's constraint lost)
 *   t2: B finishes, restores "previous" ({scn: A})    (B's constraint lost AND A's restored)
 *   t3: A finishes, restores "previous" (empty)       (also wipes anything else written during the window)
 *
 * The token-based form below writes via an atomic jsonb concatenation
 * (`metadata || jsonb_build_object(...)`) and clears via a SQL-level
 * conditional UPDATE that only fires when the stored token still
 * matches ours. The clear is therefore a true compare-and-set:
 *
 *   t0: A writes scn={token:A}              (atomic, other keys untouched)
 *   t1: B writes scn={token:B}              (atomic, overwrites scn only)
 *   t2: B's clear: WHERE token=B -> OK      (only B's scn removed)
 *   t3: A's clear: WHERE token=A -> no-op   (current token is null, not A)
 *
 * We bypass `updateSession()` (the drizzle wrapper) because it can't
 * express the `WHERE jsonb path = value` predicate — that requires a
 * raw SQL conditional UPDATE. The write uses `metadata || ...` so we
 * only touch the `scheduleNodeConstraints` key, never the entire
 * metadata field.
 */
async function applyNodeConstraintToSession(input: {
  sessionId: string;
  nodeId: string;
}): Promise<{ token: string } | null> {
  const { db } = await import('@/lib/core/db');
  const { sql } = await import('drizzle-orm');
  const token = `${input.sessionId}:${input.nodeId}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Atomically merge our key into the metadata jsonb. The || operator
  // shallow-merges jsonb objects, so this only overwrites
  // scheduleNodeConstraints and preserves every other metadata key.
  const result = await db.execute(sql`
    UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'scheduleNodeConstraints',
             jsonb_build_object('preferredNodeId', ${input.nodeId}, 'token', ${token})
           ),
           updated_at = NOW()
     WHERE id = ${input.sessionId}
     RETURNING id
  `);
  // drizzle's execute() unwraps `.rows`, so we get back an array-like.
  // Both neon-http and node-postgres drivers end up here. An empty
  // result means no session matched the id — surface as null to the
  // caller so it can treat that as a dispatch failure.
  const rowCount = Array.isArray(result)
    ? result.length
    : ((result as { rowCount?: number }).rowCount ?? 0);
  return rowCount > 0 ? { token } : null;
}

/**
 * Conditionally clear `scheduleNodeConstraints` from session.metadata
 * — but only when the stored `token` matches the one we wrote. The
 * WHERE clause makes this a true CAS at the SQL layer: between our
 * logical "read" (the WHERE predicate) and the UPDATE itself, no
 * other dispatch can sneak in a change, because PG holds the row
 * lock for the duration of this single statement.
 *
 * Best-effort: errors are logged but don't change the dispatch
 * outcome. If cleanup fails the constraint stays and the next
 * non-scheduled chat would route to the same node until something
 * else writes metadata — a soft degradation, not a correctness bug
 * for the dispatch that just ran.
 */
async function clearNodeConstraintFromSession(input: {
  sessionId: string;
  token: string;
}): Promise<void> {
  try {
    const { db } = await import('@/lib/core/db');
    const { sql } = await import('drizzle-orm');
    // PG jsonb path lookup: metadata->'scheduleNodeConstraints'->>'token'
    // returns the token as text. Only delete the scn key when that
    // token matches ours. The `metadata - 'key'` operator removes a
    // single top-level key from a jsonb object.
    await db.execute(sql`
      UPDATE sessions
         SET metadata = metadata - 'scheduleNodeConstraints',
             updated_at = NOW()
       WHERE id = ${input.sessionId}
         AND metadata->'scheduleNodeConstraints'->>'token' = ${input.token}
    `);
  } catch (err) {
    logger.warn('deliver:clear_node_constraint_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Dispatch one scheduled task to the main chat workflow.
 *
 * Guarantees:
 * - idempotency (the same scheduledFor instant is not dispatched twice)
 * - updates scheduling state after dispatch (runId, trigger timestamps, etc.)
 * - any failure in chat routing, result validation, state writeback, or
 *   completion notification fans out a 'failed' notification AND
 *   increments the task's consecutive failure counter; three
 *   consecutive failures auto-disable the task.
 */
export async function deliverScheduledTask(input: {
  taskId: string;
  scheduledFor?: string;
}) {
  const task = await getScheduledTask(input.taskId);
  if (!task) {
    throw new Error(`Scheduled task "${input.taskId}" not found.`);
  }

  if (!task.active) {
    return {
      taskId: task.id,
      status: 'inactive' as const,
      sessionId: task.sessionId,
    };
  }

  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
  if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
    throw new Error('scheduledFor must be a valid ISO datetime.');
  }

  if (scheduledFor && sameInstant(task.lastFiredFor ?? null, scheduledFor)) {
    return {
      taskId: task.id,
      status: 'duplicate' as const,
      sessionId: task.sessionId,
      runId: task.lastChatRunId ?? null,
    };
  }

  // Claim a run-slot row for this (task, plannedAt) pair. The DB partial
  // unique index (scheduled_task_runs_task_planned_uniq) makes this the
  // authoritative idempotency primitive — two concurrent ticks for the
  // same slot cannot both proceed. `created=false` means another caller
  // already owns this slot (the row is non-terminal: pending/running);
  // treat it as a duplicate. Do NOT special-case `status === 'pending'`
  // to let this caller continue: caller A may still be between
  // `claimScheduledRunSlot` and `markRunStarted`, so two callers would
  // both dispatch the chat workflow for the same slot.
  let runSlotId: string | null = null;
  if (scheduledFor) {
    const slot = await claimScheduledRunSlot({
      taskId: task.id,
      plannedAt: scheduledFor,
    });
    if (!slot.created) {
      // Another caller owns this slot — bail as duplicate regardless of
      // whether the slot row is currently pending or running. The owner
      // will drive it to a terminal state.
      return {
        taskId: task.id,
        status: 'duplicate' as const,
        sessionId: task.sessionId,
        runId: slot.run.runId ?? task.lastChatRunId ?? null,
      };
    }
    runSlotId = slot.run.id;
  }

  let userId: string | null;
  try {
    userId = await resolveScheduledTaskUserId(task.sessionId);
  } catch (lookupError) {
    logger.warn('deliver:user_lookup_failed', {
      taskId: task.id,
      sessionId: task.sessionId,
      error:
        lookupError instanceof Error
          ? lookupError.message
          : String(lookupError),
    });
    userId = null;
  }

  // Pre-flight: when the task has a preferred agentd node, probe it
  // (and any fallback candidates) BEFORE entering the chat dispatch.
  // A failed probe short-circuits as a dispatch failure — no LLM
  // invocation, immediate failure notification, counter increment.
  //
  // The resolved node constraint is written to session.metadata for
  // the duration of the chat dispatch below so execToolOnAgentd picks
  // it up, then cleared in the `finally` block. Leaving it in place
  // would force every subsequent non-scheduled chat on this session
  // to the same daemon.
  //
  // We capture a dispatch token on write and only delete our own
  // constraint on cleanup — see applyNodeConstraintToSession for why
  // this matters under concurrent dispatches of the same session.
  let nodeConstraintToken: string | null = null;
  if (!task.remoteControl && task.preferredNodeId) {
    const resolution = await resolveDispatchNode({
      preferredNodeId: task.preferredNodeId,
      allowedNodes: task.allowedNodes ?? null,
      autoFallbackNode: task.autoFallbackNode ?? false,
    });
    if ('failed' in resolution && resolution.failed) {
      // Admission gate failure (target node offline): record as SKIPPED,
      // NOT as a dispatch failure. The task itself isn't broken — the
      // runtime is. Burning the failure counter here would auto-disable
      // perfectly good tasks just because a daemon rebooted. Mirrors
      // Multica's shouldSkipDispatch admission gate (autopilot.go:1186).
      if (runSlotId) {
        await markRunSkipped(runSlotId, resolution.reason);
      }
      await sendScheduledTaskCompletion({
        task,
        runId: null,
        userId,
        status: 'failed',
        errorMessage: resolution.reason,
      });
      throw new Error(resolution.reason);
    }
    if ('node' in resolution && resolution.node) {
      // If we can't write the constraint to session.metadata, the
      // LLM tool layer (execToolOnAgentd) would silently fall back
      // to selectBestNode — routing the task to whatever node the
      // scheduler happens to pick, ignoring the user's explicit
      // preferredNodeId. That's worse than failing the dispatch:
      // the user picked a specific node because they need its
      // hardware/data/locality, and silently running elsewhere
      // would do the wrong thing without telling them. Treat the
      // write as required and fail-stop on error.
      const applied = await applyNodeConstraintToSession({
        sessionId: task.sessionId,
        nodeId: resolution.node.nodeID,
      });
      if (!applied) {
        const reason = `Failed to apply node constraint to session ${task.sessionId} for task ${task.id}.`;
        if (runSlotId) {
          await markRunFailed(runSlotId, {
            failureReason: classifyFailure(reason),
            errorMessage: reason,
          });
        }
        await handleDispatchFailure(task, userId, reason);
        throw new Error(reason);
      }
      nodeConstraintToken = applied.token;
    }
  }
  let dispatchResult: {
    taskId: string;
    sessionId: string;
    runId: string;
    status: 'dispatched';
  } | null = null;
  if (runSlotId) {
    // markRunStarted is the final CAS that confirms THIS caller still
    // owns the slot. If it returns false, a concurrent caller or the
    // reaper already moved the row out of 'pending' — we must NOT
    // dispatch, otherwise two callers drive the same slot (the race
    // this gate exists to prevent). Treat it as a recovered-abort and
    // mark the run failed so the slot can be reclaimed.
    const started = await markRunStarted(runSlotId).catch((err) => {
      logger.warn('deliver:mark_started_failed', {
        runSlotId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    if (!started) {
      logger.warn('deliver:slot_lost_before_dispatch', { runSlotId });
      await markRunFailed(runSlotId, {
        failureReason: 'slot_lost',
        errorMessage:
          'run slot was no longer pending at dispatch time (reaped or claimed by another caller)',
      }).catch(() => {});
      return {
        taskId: task.id,
        status: 'duplicate' as const,
        sessionId: task.sessionId,
        runId: task.lastChatRunId ?? null,
      };
    }
  }
  // Refresh the heartbeat lease while the workflow runs so the reaper
  // can distinguish this live dispatch from a truly stuck one. Best-effort:
  // a transient DB blip on a tick must not fail the run. The interval is
  // declared before the `try` and cleared in the existing `finally`
  // below, so every exit path (success, chatMain throw, the catch) stops
  // the timer. Started AFTER markRunStarted so the lease clock is already
  // stamped (closing the window to the first tick).
  const heartbeat = setInterval(() => {
    if (runSlotId) {
      void markRunHeartbeat(runSlotId).catch((err) => {
        logger.warn('deliver:heartbeat_failed', {
          runSlotId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }, 30_000);
  try {
    const source = (await buildScheduledSource(task.sessionId)) ?? {
      type: 'scheduled' as const,
    };

    const routed = await chatMain(
      {
        sessionId: task.sessionId,
        trigger: 'route-message',
        input: {
          text: task.prompt,
          parts: [{ type: 'text', text: task.prompt }],
        },
      },
      { source },
    );

    if (routed.kind !== 'message') {
      throw new Error('Scheduled dispatch must return a message result.');
    }

    const now = new Date();
    await updateScheduledTask(task.id, {
      lastTriggeredAt: now,
      lastFiredFor: scheduledFor,
      lastChatRunId: routed.result.runId,
      active: task.type !== 'delay',
      nextRunAt: task.type === 'delay' ? null : task.nextRunAt,
      // Success — clear the consecutive failure counter.
      failureCount: 0,
      disabledByFailure: false,
    });

    dispatchResult = {
      taskId: task.id,
      sessionId: routed.result.sessionId,
      runId: routed.result.runId,
      status: 'dispatched' as const,
    };

    logger.info('deliver:success', {
      taskId: task.id,
      sessionId: task.sessionId,
      runId: routed.result.runId,
      type: task.type,
    });
    if (runSlotId) {
      await markRunCompleted(runSlotId, routed.result.runId).catch((err) => {
        logger.warn('deliver:mark_completed_failed', {
          runSlotId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await handleDispatchFailure(task, userId, errorMessage);
    if (runSlotId) {
      const failureReason = classifyFailure(errorMessage);
      await markRunFailed(runSlotId, {
        failureReason,
        errorMessage,
      }).catch((err) => {
        logger.warn('deliver:mark_failed_failed', {
          runSlotId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    // Restore session.metadata so the node constraint only applies to
    // this dispatch run. Without this, every subsequent non-scheduled
    // chat on the same session would route to the same daemon.
    // The token-based clear is a CAS: if a concurrent dispatch has
    // since overwritten our constraint, this is a no-op.
    if (nodeConstraintToken) {
      await clearNodeConstraintFromSession({
        sessionId: task.sessionId,
        token: nodeConstraintToken,
      });
    }
  }

  // Completion notification runs OUTSIDE the dispatch try/catch so a
  // notification failure cannot bump the task's failure counter or
  // flip it into auto-disabled state — the dispatch already
  // succeeded (state is persisted, runId is recorded). A buggy or
  // transient notification error is logged but doesn't undo that.
  // sendScheduledTaskCompletion internally swallows most errors, but
  // we don't want to depend on that contract for correctness.
  try {
    await sendScheduledTaskCompletion({
      task,
      runId: dispatchResult.runId,
      userId,
      status: 'completed',
    });
  } catch (notifError) {
    logger.warn('deliver:completion_notify_failed', {
      taskId: task.id,
      runId: dispatchResult.runId,
      error:
        notifError instanceof Error ? notifError.message : String(notifError),
    });
  }

  return dispatchResult;
}

/**
 * Centralized failure handler: bumps the consecutive failure counter,
 * auto-disables the task when it crosses MAX_SCHEDULE_FAILURES, and
 * fires the failure notification. Pulled out so the node-pre-flight
 * branch and the chat-dispatch catch share the exact same handling.
 */
async function handleDispatchFailure(
  task: Awaited<ReturnType<typeof getScheduledTask>>,
  userId: string | null,
  errorMessage: string,
): Promise<void> {
  if (!task) return;
  const nextCount = (task.failureCount ?? 0) + 1;
  const shouldDisable = nextCount >= MAX_SCHEDULE_FAILURES;
  try {
    await updateScheduledTask(task.id, {
      failureCount: nextCount,
      ...(shouldDisable ? { active: false, disabledByFailure: true } : {}),
    });
  } catch (err) {
    logger.warn('deliver:failure_counter_write_failed', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await sendScheduledTaskCompletion({
    task,
    runId: null,
    userId,
    status: 'failed',
    errorMessage: shouldDisable
      ? `${errorMessage} (task auto-disabled after ${nextCount} consecutive failures)`
      : errorMessage,
  });
}
