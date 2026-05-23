import { getNotificationPreferences } from '@/lib/core/db/notification';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import { getNotificationManager } from './notification-manager';
import type {
  L2Action,
  NotificationPayload,
} from './notification-types';

const logger = createLogger('notification.send');

/**
 * Send a notification to the user via their preferred IM channel.
 * Automatically handles fallback to backup channels if the preferred one fails.
 */
export async function sendNotification(params: {
  source: ChatSource;
  payload: NotificationPayload;
  userId?: string;
}): Promise<{ success: boolean; channel: string; error?: string }> {
  const { source, payload, userId } = params;

  if (source.type !== 'im') {
    logger.warn('notification skipped: non-IM source', {
      sourceType: source.type,
    });
    return { success: false, channel: 'none', error: 'Non-IM source' };
  }

  const prefs = userId ? await getNotificationPreferences(userId) : null;
  const preferredChannel = prefs?.preferredChannel ?? source.adapter;
  const fallbackChannels = prefs?.fallbackChannels?.length
    ? prefs.fallbackChannels
    : [source.adapter];

  const mgr = getNotificationManager();

  // Use L2-specific send for decision notifications
  if (payload.type === 'decision') {
    const result = await mgr.sendL2Decision({
      taskId: payload.taskId,
      decisionId: payload.decisionId,
      title: payload.title,
      body: payload.body,
      command: payload.command,
      score: payload.score,
      reason: payload.reason,
      preferredChannel,
      fallbackChannels,
      targetChatId: source.threadId,
      targetUserId: userId ?? source.userId ?? undefined,
    });

    logger.info('L2 decision notification sent', {
      taskId: payload.taskId,
      decisionId: payload.decisionId,
      channel: result.channel,
      success: result.success,
    });

    return {
      success: result.success,
      channel: result.channel,
      error: result.error,
    };
  }

  const result = await mgr.send({
    taskId: payload.taskId,
    notificationType: payload.type,
    payload,
    preferredChannel,
    fallbackChannels,
    targetChatId: source.threadId,
    targetUserId: userId ?? source.userId ?? undefined,
  });

  logger.info('notification sent', {
    taskId: payload.taskId,
    type: payload.type,
    channel: result.channel,
    success: result.success,
  });

  return {
    success: result.success,
    channel: result.channel,
    error: result.error,
  };
}
