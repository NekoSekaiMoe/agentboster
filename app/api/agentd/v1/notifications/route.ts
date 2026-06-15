/**
 * Create notification endpoint (daemon → web).
 *
 * P0.3: agentd's QuestionService.Ask and dispatcher security alerts
 * POST here with a Notification payload. Previously this route didn't
 * exist, so all ask_question notifications and security alerts failed
 * silently.
 *
 * Persists the notification to the notifications table. If the type
 * is "question", also enqueues an entry in the L2 decision queue so
 * the user can answer inline in the chat UI (DecisionCard).
 */

import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import {
  getNotificationPreferences,
  upsertNotificationPreferences,
} from '@/lib/core/db/notification';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.notifications');

const requestSchema = z.object({
  agent_id: z.string().default(''),
  task_id: z.string().default(''),
  type: z.string(),
  title: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}).catch({}),
});

// GET returns either channel health (?type=health) or a user's
// notification preferences (?user_id=...). Both were on the original
// (chat)/api/agentd/v1/notifications route and got dropped during the
// P0.4 (chat)→root merge.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id');
  const type = searchParams.get('type');

  if (type === 'health') {
    try {
      const mgr = getNotificationManager();
      const health = mgr.getAllChannelHealth();
      return Response.json({ success: true, data: health });
    } catch (err) {
      logger.error('channel health failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { success: false, error: 'health failed' },
        { status: 500 },
      );
    }
  }

  if (userId) {
    const prefs = await getNotificationPreferences(userId);
    return Response.json({ success: true, data: prefs });
  }

  return Response.json(
    { success: false, error: 'Missing user_id or type=health' },
    { status: 400 },
  );
}

// PUT updates a user's notification preferences (preferred channel +
// fallback list + enabled flag).
export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { userId, preferredChannel, fallbackChannels, enabled } = body as {
    userId?: string;
    preferredChannel?: string;
    fallbackChannels?: string[];
    enabled?: boolean;
  };

  if (!userId || !preferredChannel) {
    return Response.json(
      { success: false, error: 'Missing userId or preferredChannel' },
      { status: 400 },
    );
  }

  const prefs = await upsertNotificationPreferences({
    userId,
    preferredChannel,
    fallbackChannels: fallbackChannels ?? [],
    enabled: enabled ?? true,
  });

  return Response.json({ success: true, data: prefs });
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: 'Invalid notification',
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  try {
    // Persist to notifications table.
    const [row] = await db
      .insert(notifications)
      .values({
        taskId: data.task_id || 'unknown',
        decisionId:
          typeof metadata['decisionId'] === 'string'
            ? (metadata['decisionId'] as string)
            : null,
        notificationType: 'decision',
        payload: {
          type: data.type,
          title: data.title,
          message: data.message,
          ...metadata,
        },
        status: 'sent',
        channel:
          typeof metadata['channel'] === 'string'
            ? (metadata['channel'] as string)
            : 'in-app',
        targetChatId:
          (metadata['chatId'] as string | undefined) ??
          (metadata['session_id'] as string | undefined) ??
          'unknown',
        targetUserId:
          (metadata['userId'] as string | undefined) ??
          (metadata['user_id'] as string | undefined) ??
          null,
      })
      .returning();

    // For question-type notifications, mirror into the L2 decision
    // queue so the chat UI can render a DecisionCard and capture the
    // user's answer.
    if (data.type === 'question') {
      try {
        const queue = getDecisionQueue();
        const sessionId =
          (metadata['session_id'] as string | undefined) ??
          (metadata['sessionId'] as string | undefined) ??
          '';
        const taskId =
          (metadata['task_id'] as string | undefined) ?? data.task_id ?? '';
        const prompts = (metadata['prompts'] as unknown) ?? undefined;

        if (sessionId && taskId) {
          await queue.enqueue({
            decisionId: `q_${taskId}_${Date.now()}`,
            type: 'question' as const,
            taskId,
            sessionId,
            agentId: data.agent_id || undefined,
            question: data.message,
            prompts: Array.isArray(prompts) ? (prompts as never) : undefined,
            status: 'pending' as const,
            createdAt: new Date(),
            timeoutAt: new Date(Date.now() + 5 * 60 * 1000),
          });
        }
      } catch (err) {
        logger.warn('failed to mirror question to decision queue', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('notification created', {
      id: row?.id,
      type: data.type,
      taskId: data.task_id,
    });

    return Response.json({
      success: true,
      data: { id: row?.id },
    });
  } catch (error) {
    logger.error('notification create failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Create failed' },
      { status: 500 },
    );
  }
}
