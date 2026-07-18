import { getNotificationPreferences } from '@/lib/core/db/notification';
import { db } from '@/lib/core/db';
import { sessions } from '@/lib/core/db/schema';
import { getConfig } from '@/lib/core/kv/config';
import { set as kvSet } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
import type { CompletionNotification } from '@/lib/extra/channels/notification-types';
import { ensureNotificationChannels } from '@/lib/extra/channels/register-channels';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';

const logger = createLogger('workflow.scheduled.notify');

const DESKTOP_KV_TTL_SECONDS = 24 * 60 * 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function imAdapterOverride(notifyChannel: string | null): string | null {
  if (!notifyChannel) return null;
  if (notifyChannel === 'im:auto' || notifyChannel === 'default') return null;
  if (notifyChannel.startsWith('im:')) {
    return notifyChannel.slice('im:'.length);
  }
  return null;
}

/**
 * Resolve the userId that owns the session a scheduled task is attached
 * to. Returns null when the session cannot be found.
 */
export async function resolveScheduledTaskUserId(
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Send a completion/failure notification for a fired scheduled task,
 * honoring the per-task `notifyChannel` / `remoteControl` routing.
 *
 * Routing rules:
 *  - Desktop: KV row written for the Desktop client to poll.
 *  - IM: dispatched via NotificationManager with optional channel
 *    override.
 *
 * Never throws — notification failures are logged and swallowed so
 * they cannot break the dispatch path.
 */
export async function sendScheduledTaskCompletion(input: {
  task: {
    id: string;
    sessionId: string;
    title: string | null;
    prompt: string;
    notifyChannel: string | null;
    remoteControl: boolean | null;
  };
  runId: string | null;
  userId: string | null;
  status: 'completed' | 'failed';
  errorMessage?: string;
}): Promise<void> {
  const { task, runId, userId, status } = input;
  const notifyChannel = task.notifyChannel ?? null;
  const remoteControl = task.remoteControl ?? false;

  try {
    // Routing rules (see schema/scheduled.ts notifyChannel comment):
    //  - 'desktop':        force a desktop KV notification.
    //  - null/'default':   follow the user's notification_preferences via
    //                      the IM path; falls back to desktop if no IM
    //                      preference is configured.
    //  - 'im:auto'/...:    explicit IM routing (handled below).
    // When `remoteControl` is true the user expects the task to drive a
    // CLI / IM session, so a desktop KV notification is not useful —
    // route through the IM path even when notifyChannel is empty.
    const explicitDesktop = notifyChannel === 'desktop';
    const useDesktop = explicitDesktop && !remoteControl;

    if (useDesktop) {
      await writeDesktopNotification({
        taskId: task.id,
        runId,
        title: task.title,
        prompt: task.prompt,
        status,
        errorMessage: input.errorMessage,
      });
      return;
    }

    await sendImNotification({
      task,
      runId,
      userId,
      status,
      errorMessage: input.errorMessage,
      notifyChannel,
    });
  } catch (error) {
    logger.warn('send_failed', {
      taskId: task.id,
      runId: runId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeDesktopNotification(input: {
  taskId: string;
  runId: string | null;
  title: string | null;
  prompt: string;
  status: 'completed' | 'failed';
  errorMessage?: string;
}): Promise<void> {
  const key = `desktop-notify:scheduled:${input.taskId}:${input.runId ?? 'no-run'}`;
  const value = {
    taskId: input.taskId,
    runId: input.runId,
    title: input.title,
    prompt: input.prompt,
    status: input.status,
    errorMessage: input.errorMessage,
    createdAt: new Date().toISOString(),
  };
  await kvSet(key, value, { ex: DESKTOP_KV_TTL_SECONDS });
  logger.info('desktop_notify_written', {
    taskId: input.taskId,
    runId: input.runId ?? null,
  });
}

async function sendImNotification(input: {
  task: {
    id: string;
    sessionId: string;
    title: string | null;
    prompt: string;
    notifyChannel: string | null;
    remoteControl: boolean | null;
  };
  runId: string | null;
  userId: string | null;
  status: 'completed' | 'failed';
  errorMessage?: string;
  notifyChannel: string | null;
}): Promise<void> {
  const { task, userId, status, errorMessage, notifyChannel } = input;

  const payload: CompletionNotification = {
    type: 'completion',
    taskId: task.id,
    status,
    title: task.title ?? 'Scheduled task',
    summary: truncate(task.prompt, 200),
    channelFallback: [],
  };
  if (status === 'failed' && errorMessage) {
    payload.details = { error: errorMessage };
  }

  const config = await getConfig();
  ensureNotificationChannels(config);

  const override = imAdapterOverride(notifyChannel);
  let preferredChannel: string;
  let fallbackChannels: string[];

  if (override) {
    preferredChannel = override;
    fallbackChannels = [override];
  } else if (userId) {
    const prefs = await getNotificationPreferences(userId);
    if (prefs?.preferredChannel) {
      preferredChannel = prefs.preferredChannel;
      fallbackChannels = prefs.fallbackChannels?.length
        ? prefs.fallbackChannels
        : [prefs.preferredChannel];
    } else {
      // No IM preference configured — fall back to desktop KV write so
      // the user still sees the result somewhere.
      await writeDesktopNotification({
        taskId: task.id,
        runId: input.runId,
        title: task.title,
        prompt: task.prompt,
        status,
        errorMessage,
      });
      return;
    }
  } else {
    // No override and no userId — desktop KV is the only option.
    await writeDesktopNotification({
      taskId: task.id,
      runId: input.runId,
      title: task.title,
      prompt: task.prompt,
      status,
      errorMessage,
    });
    return;
  }

  const mgr = getNotificationManager();
  const result = await mgr.send({
    taskId: task.id,
    notificationType: payload.type,
    payload,
    preferredChannel,
    fallbackChannels,
    targetChatId: task.sessionId,
    targetUserId: userId ?? undefined,
  });

  logger.info('im_notify_sent', {
    taskId: task.id,
    runId: input.runId ?? null,
    channel: result.channel,
    success: result.success,
  });
}
