import { chatMain } from '@/lib/chat/index';
import { getScheduledTask, updateScheduledTask } from '@/lib/core/db/scheduled';
import { createLogger } from '@/lib/utils/logger';
import { sameInstant } from './utils';
import {
  resolveScheduledTaskUserId,
  sendScheduledTaskCompletion,
} from './notify';

const logger = createLogger('workflow.scheduled.dispatch');

/**
 * Dispatch one scheduled task to the main chat workflow.
 *
 * Guarantees:
 * - idempotency (the same scheduledFor instant is not dispatched twice)
 * - updates scheduling state after dispatch (runId, trigger timestamps, etc.)
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
    // This trigger instant was already dispatched; return duplicate to avoid re-dispatch.
    return {
      taskId: task.id,
      status: 'duplicate' as const,
      sessionId: task.sessionId,
      runId: task.lastChatRunId ?? null,
    };
  }

  // Scheduled tasks always use route-message so they reuse the full chat routing stack.
  // Each fire must create a fresh persisted session for the main workflow.
  let routed: Awaited<ReturnType<typeof chatMain>>;
  try {
    routed = await chatMain(
      {
        trigger: 'route-message',
        input: {
          text: task.prompt,
          parts: [{ type: 'text', text: task.prompt }],
        },
      },
      {
        source: {
          type: 'scheduled',
        },
      },
    );
  } catch (error) {
    const userId = await resolveScheduledTaskUserId(task.sessionId);
    await sendScheduledTaskCompletion({
      task,
      runId: null,
      userId,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (routed.kind !== 'message') {
    throw new Error('Scheduled dispatch must return a message result.');
  }

  const now = new Date();
  // Always write back lastChatRunId so this dispatch result can be traced.
  await updateScheduledTask(task.id, {
    lastTriggeredAt: now,
    lastFiredFor: scheduledFor,
    lastChatRunId: routed.result.runId,
    active: task.type !== 'delay',
    nextRunAt: task.type === 'delay' ? null : task.nextRunAt,
  });

  // Fire-and-forget completion notification. The helper never throws.
  const userId = await resolveScheduledTaskUserId(task.sessionId);
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
}
