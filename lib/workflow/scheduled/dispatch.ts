import { chatMain } from '@/lib/chat/index';
import { getSession } from '@/lib/core/db/chat';
import { getScheduledTask, updateScheduledTask } from '@/lib/core/db/scheduled';
import { createLogger } from '@/lib/utils/logger';
import { sameInstant } from './utils';
import {
  resolveScheduledTaskUserId,
  sendScheduledTaskCompletion,
} from './notify';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('workflow.scheduled.dispatch');

/**
 * Build the chat source for a scheduled dispatch by reusing the task's
 * attached session. This matters for `remoteControl`: local-cli /
 * computer-use tools gate on `isCliOnlineForSession(sessionId)`, and the
 * lookup only hits when the dispatched chat run shares the task's
 * sessionId. Reusing the session also keeps userId and channel bindings
 * consistent with the originating session (web / cli:<clientId>).
 *
 * Returns null when the session can't be resolved or doesn't carry the
 * fields a stricter source type needs (e.g. CLI source requires both
 * clientId and userId to pass `evaluateSessionAccess`). Callers fall
 * back to the historical `{ type: 'scheduled' }` source in that case.
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

  // CLI sessions use channel `cli:<clientId>` per CLIChatSource contract.
  if (session.channel.startsWith('cli:') && userId) {
    return {
      type: 'cli',
      clientId: session.channel.slice('cli:'.length),
      userId,
      label: session.title ?? null,
    };
  }

  // IM channels or sessions without a bound userId can't be expressed
  // as a stricter source type without tripping `evaluateSessionAccess`
  // (`forbidden`). Fall back to the historical 'scheduled' source so
  // the dispatch still goes through; local-cli gating by sessionId
  // works regardless of source type.
  return { type: 'scheduled' };
}

/**
 * Dispatch one scheduled task to the main chat workflow.
 *
 * Guarantees:
 * - idempotency (the same scheduledFor instant is not dispatched twice)
 * - updates scheduling state after dispatch (runId, trigger timestamps, etc.)
 * - any failure in chat routing, result validation, state writeback, or
 *   completion notification fans out a 'failed' notification.
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

  // Resolve the userId up front; wrap in a protected try so a lookup
  // failure doesn't mask the original dispatch error.
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

  try {
    // Build the source from the task's session so local-cli / remote
    // control gating (which keys off sessionId) works when the session
    // is a CLI session. Falls back to the historical 'scheduled' source
    // if the session can't be loaded.
    const source = (await buildScheduledSource(task.sessionId)) ?? {
      type: 'scheduled' as const,
    };

    // Scheduled tasks always use route-message so they reuse the full
    // chat routing stack, and they carry the task's sessionId so the
    // main workflow reuses the originating session instead of minting
    // a fresh anonymous one.
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
    // Always write back lastChatRunId so this dispatch result can be traced.
    await updateScheduledTask(task.id, {
      lastTriggeredAt: now,
      lastFiredFor: scheduledFor,
      lastChatRunId: routed.result.runId,
      active: task.type !== 'delay',
      nextRunAt: task.type === 'delay' ? null : task.nextRunAt,
    });

    // Fire completion notification. Failures here must not fail the
    // dispatch — they're logged inside the helper.
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

    // Send failure notification. ResolveScheduledTaskUserId has already
    // been called above (in a protected try) so it cannot mask this
    // error; sendScheduledTaskCompletion itself never throws.
    await sendScheduledTaskCompletion({
      task,
      runId: null,
      userId,
      status: 'failed',
      errorMessage,
    });

    throw error;
  }
}
