import { getNotificationPreferences } from '@/lib/core/db/notification';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import { getNotificationManager } from './notification-manager';
import type { NotificationPayload } from './notification-types';

const logger = createLogger('notification.send');

/**
 * Send a notification to the user via their preferred IM channel.
 * Automatically handles fallback to backup channels if the preferred one fails.
 *
 * Replicates Asika's notification dispatch pattern:
 * - Preferred channel first → fallback channels → offline queue
 * - Exponential backoff retry (1s/2s/4s/8s/16s)
 * - Deduplication via Redis KV (task_id + notification_type)
 * - Channel health tracking with 3-failure threshold
 */
export async function sendNotification(params: {
  source: ChatSource;
  payload: NotificationPayload;
  userId?: string;
}): Promise<{ success: boolean; channel: string; error?: string }> {
  const { source, payload, userId } = params;

  // Only IM sources can receive notifications
  if (source.type !== 'im') {
    logger.warn('notification skipped: non-IM source', {
      sourceType: source.type,
    });
    return { success: false, channel: 'none', error: 'Non-IM source' };
  }

  // Get user preferences
  const prefs = userId ? await getNotificationPreferences(userId) : null;
  const preferredChannel = prefs?.preferredChannel ?? source.adapter;
  const fallbackChannels = prefs?.fallbackChannels?.length
    ? prefs.fallbackChannels
    : [source.adapter]; // fallback to the source channel

  const mgr = getNotificationManager();

  const result = await mgr.send({
    taskId: getTaskId(payload),
    notificationType: payload.type,
    payload,
    preferredChannel,
    fallbackChannels,
    targetChatId: source.threadId,
    targetUserId: userId ?? source.userId ?? undefined,
    expiresAt:
      payload.type === 'decision' ? new Date(payload.expiresAt) : undefined,
  });

  logger.info('notification sent', {
    taskId: getTaskId(payload),
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

function getTaskId(payload: NotificationPayload): string {
  return payload.taskId;
}
