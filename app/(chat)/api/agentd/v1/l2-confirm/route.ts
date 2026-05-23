import { updateTaskStatus } from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l2-confirm');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, decisionId, option, chatId, userId } = body;

    if (!taskId || !decisionId || !option) {
      return Response.json(
        {
          success: false,
          error: 'Missing required fields: taskId, decisionId, option',
        },
        { status: 400 },
      );
    }

    logger.info('L2 confirmation received', {
      taskId,
      decisionId,
      option,
      chatId,
      userId,
    });

    if (option === 'reject') {
      // User rejected — mark task as cancelled
      await updateTaskStatus(
        taskId,
        'cancelled',
        'Rejected by user via L2 authorization',
      );

      // Update notification status
      const pending = await import('@/lib/core/db/notification');
      // Find and update the notification
      const { db } = await import('@/lib/core/db');
      const { notifications } = await import('@/lib/core/db/schema');
      const { eq, and } = await import('drizzle-orm');

      await db
        .update(notifications)
        .set({ status: 'expired' })
        .where(
          and(
            eq(notifications.taskId, taskId),
            eq(notifications.decisionId, decisionId),
          ),
        );

      return Response.json({
        success: true,
        data: { taskId, decision: 'rejected', message: 'Task cancelled.' },
      });
    }

    // User authorized — record the authorization window
    const { getNotificationManager } = await import(
      '@/lib/extra/channels/notification-manager'
    );
    const mgr = getNotificationManager();
    const { getKV } = await import('@/lib/core/kv');
    const kv = getKV();

    // Store the authorization decision with TTL
    const windowKey = `l2:auth:${taskId}:${chatId}`;
    const windowTTL = getWindowTTL(option);
    await kv.set(
      windowKey,
      JSON.stringify({
        option,
        chatId,
        userId,
        decidedAt: new Date().toISOString(),
      }),
      windowTTL,
    );

    // Update task status to approved
    await updateTaskStatus(taskId, 'running', `L2 authorized: ${option}`);

    return Response.json({
      success: true,
      data: {
        taskId,
        decision: option,
        message: `Authorized for: ${option}`,
      },
    });
  } catch (error) {
    logger.error('L2 confirmation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to process L2 confirmation' },
      { status: 500 },
    );
  }
}

function getWindowTTL(option: string): number {
  switch (option) {
    case 'once':
      return 0; // immediate, no caching
    case '10min':
      return 10 * 60;
    case '1hour':
      return 60 * 60;
    case '1day':
      return 24 * 60 * 60;
    case 'always':
      return 7 * 24 * 60 * 60; // 7 days (session-scoped)
    default:
      return 10 * 60;
  }
}
