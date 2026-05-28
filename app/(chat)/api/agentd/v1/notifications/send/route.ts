import { createNotification } from '@/lib/core/db/notification';
import type { NotificationPayload } from '@/lib/extra/channels/notification-types';
import { sendNotification } from '@/lib/extra/channels/send-notification';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('api.agentd.notifications.send');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, task_id, status, title, summary, details, source } = body;

    if (!task_id || !type) {
      return Response.json(
        { success: false, error: 'Missing task_id or type' },
        { status: 400 },
      );
    }

    const payload: NotificationPayload =
      type === 'completion'
        ? {
            type: 'completion',
            taskId: task_id,
            status:
              (status as 'completed' | 'failed' | 'cancelled') ?? 'completed',
            title: title ?? 'Task Update',
            summary: summary ?? '',
            details: details ?? {},
            channelFallback: body.channel_fallback ?? [
              'telegram',
              'discord',
              'slack',
              'feishu',
            ],
          }
        : (body as NotificationPayload);

    // Persist notification record
    const chatSource = source as ChatSource | undefined;
    const targetChatId =
      chatSource?.type === 'im' ? chatSource.threadId : 'default';

    await createNotification({
      taskId: task_id,
      notificationType: type,
      payload: payload as unknown as Record<string, unknown>,
      channel: chatSource?.type === 'im' ? chatSource.adapter : 'telegram',
      targetChatId,
      targetUserId:
        chatSource?.type === 'im'
          ? (chatSource.userId ?? undefined)
          : undefined,
    });

    if (chatSource?.type === 'im') {
      const result = await sendNotification({
        source: chatSource,
        payload,
        userId: chatSource.userId ?? undefined,
      });

      logger.info('notification dispatched', {
        taskId: task_id,
        type,
        channel: result.channel,
        success: result.success,
      });

      return Response.json({
        success: result.success,
        data: { channel: result.channel },
      });
    }

    return Response.json({ success: true, data: { persisted: true } });
  } catch (error) {
    logger.error('notification send failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to send notification' },
      { status: 500 },
    );
  }
}
