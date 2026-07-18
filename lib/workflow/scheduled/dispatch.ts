import { chatMain } from '@/lib/chat/index';
import { getSession, updateSession } from '@/lib/core/db/chat';
import { getScheduledTask, updateScheduledTask } from '@/lib/core/db/scheduled';
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
 * Returns the original metadata so the caller can restore it (via
 * {@link clearNodeConstraintFromSession}) once the dispatch run
 * completes. Without restoring, every subsequent non-scheduled chat
 * on this session would keep being forced to the same node.
 */
async function applyNodeConstraintToSession(input: {
  sessionId: string;
  nodeId: string;
}): Promise<Record<string, unknown> | null> {
  const session = await getSession(input.sessionId);
  if (!session) return null;
  const previousMetadata = session.metadata ?? {};
  const metadata = {
    ...previousMetadata,
    scheduleNodeConstraints: { preferredNodeId: input.nodeId },
  };
  await updateSession(input.sessionId, { metadata });
  return previousMetadata;
}

/**
 * Restore session.metadata to its pre-dispatch state. Called in a
 * `finally` after the chat dispatch completes (or fails) so the
 * constraint only applies to tool calls issued by THIS dispatch run.
 *
 * Best-effort: errors are logged but don't change the dispatch
 * outcome. If cleanup fails the metadata stays stale and the next
 * non-scheduled chat would route to the same node — a soft degradation,
 * not a correctness bug for the dispatch that just ran.
 */
async function clearNodeConstraintFromSession(input: {
  sessionId: string;
  previousMetadata: Record<string, unknown> | null;
}): Promise<void> {
  if (!input.previousMetadata) return;
  try {
    await updateSession(input.sessionId, { metadata: input.previousMetadata });
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
  // it up, then restored in the `finally` block. Leaving it in place
  // would force every subsequent non-scheduled chat on this session
  // to the same daemon.
  let previousSessionMetadata: Record<string, unknown> | null = null;
  let nodeConstraintApplied = false;
  if (!task.remoteControl && task.preferredNodeId) {
    const resolution = await resolveDispatchNode({
      preferredNodeId: task.preferredNodeId,
      allowedNodes: task.allowedNodes ?? null,
      autoFallbackNode: task.autoFallbackNode ?? false,
    });
    if ('failed' in resolution && resolution.failed) {
      await handleDispatchFailure(task, userId, resolution.reason);
      throw new Error(resolution.reason);
    }
    if ('node' in resolution && resolution.node) {
      try {
        previousSessionMetadata = await applyNodeConstraintToSession({
          sessionId: task.sessionId,
          nodeId: resolution.node.nodeID,
        });
        nodeConstraintApplied = true;
      } catch (err) {
        // Best-effort: if we can't write the constraint, the LLM tool
        // layer will fall back to selectBestNode. Log and continue.
        logger.warn('deliver:write_node_constraint_failed', {
          taskId: task.id,
          sessionId: task.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

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

    await sendScheduledTaskCompletion({
      task,
      runId: routed.result.runId,
      userId,
      status: 'completed',
    });

    logger.info('deliver:success', {
      taskId: task.id,
      sessionId: task.sessionId,
      runId: routed.result.runId,
      type: task.type,
    });

    return {
      taskId: task.id,
      sessionId: routed.result.sessionId,
      runId: routed.result.runId,
      status: 'dispatched' as const,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await handleDispatchFailure(task, userId, errorMessage);
    throw error;
  } finally {
    // Restore session.metadata so the node constraint only applies to
    // this dispatch run. Without this, every subsequent non-scheduled
    // chat on the same session would route to the same daemon.
    if (nodeConstraintApplied) {
      await clearNodeConstraintFromSession({
        sessionId: task.sessionId,
        previousMetadata: previousSessionMetadata,
      });
    }
  }
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
