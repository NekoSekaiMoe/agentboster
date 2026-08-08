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

export const dynamic = 'force-dynamic';

import { resolveAgentdResourceAccess, getResourceErrorMessage, getResourceErrorStatus } from '@/lib/core/db/agentd';
import {
  createNotification,
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
// fallback list + enabled flag). Identity is derived from the
// task/session scope, NEVER trusted from the body — mirroring the
// same-file POST handler and the memories routes.
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      preferredChannel,
      fallbackChannels,
      enabled,
      task_id: taskId,
      session_id: sessionId,
    } = body as {
      preferredChannel?: string;
      fallbackChannels?: string[];
      enabled?: boolean;
      task_id?: string;
      session_id?: string;
    };

    if (!preferredChannel) {
      return Response.json(
        { success: false, error: 'Missing preferredChannel' },
        { status: 400 },
      );
    }

    // Derive the owning user from the task/session scope. A bare
    // user_id field in the body is ignored — it is not a sufficient
    // identity proof for an agentd-key-authenticated route.
    const access = await resolveAgentdResourceAccess({
      taskId: taskId ?? null,
      sessionId: sessionId ?? null,
    });

    const prefs = await upsertNotificationPreferences({
      userId: access.userId,
      preferredChannel,
      fallbackChannels: fallbackChannels ?? [],
      enabled: enabled ?? true,
    });

    return Response.json({ success: true, data: prefs });
  } catch (error) {
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { success: false, error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('notification preferences update failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Internal error' },
      { status: 500 },
    );
  }
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

  // Normalize task / session identifiers across snake_case and camelCase
  // spellings, whether they arrive at the top level (data.task_id) or in
  // metadata. The daemon's callers are inconsistent: some send
  // metadata.taskId / metadata.sessionId, others metadata.task_id /
  // metadata.session_id. Resolving once and reusing the same values for
  // owner resolution AND the decision-queue mirror below keeps ownership
  // from silently dropping to null when only a camelCase field is set.
  const taskId =
    (typeof data.task_id === 'string' && data.task_id) ||
    (typeof metadata.task_id === 'string' && metadata.task_id) ||
    (typeof metadata.taskId === 'string' && metadata.taskId) ||
    '';
  const sessionId =
    (typeof metadata.session_id === 'string' && metadata.session_id) ||
    (typeof metadata.sessionId === 'string' && metadata.sessionId) ||
    '';

  // Derive the owning user from the task/session scope so the row is
  // attributable for per-user filtering. Body/metadata userId is the IM
  // delivery target, not the tenancy boundary.
  let ownerUserId: string | null = null;
  try {
    ownerUserId = (
      await resolveAgentdResourceAccess({
        taskId: taskId || null,
        sessionId: sessionId || null,
      })
    ).userId;
  } catch (err) {
    // Scope unavailable — leave null; row stays deliverable via metadata.
    logger.warn('scope unavailable; notification stays deliverable via metadata', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Persist to notifications table via the canonical DAL. This route
    // creates rows already in 'sent' state because the daemon has
    // synchronously delivered the notification to the IM channel before
    // this call (QuestionService.Ask / dispatcher security alerts) — the
    // row is an audit record of a delivery that already happened, not a
    // pending delivery to attempt. The DAL defaults to 'pending'; the
    // explicit status override keeps the prior behavior without smuggling
    // a different value past the DAL boundary.
    const row = await createNotification({
      userId: ownerUserId,
      taskId: taskId || 'unknown',
      decisionId:
        typeof metadata.decisionId === 'string'
          ? (metadata.decisionId as string)
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
        typeof metadata.channel === 'string'
          ? (metadata.channel as string)
          : 'in-app',
      targetChatId:
        (metadata.chatId as string | undefined) ??
        (metadata.session_id as string | undefined) ??
        'unknown',
      targetUserId:
        (metadata.userId as string | undefined) ??
        (metadata.user_id as string | undefined) ??
        null,
    });

    // For question-type notifications, mirror into the L2 decision
    // queue so the chat UI can render a DecisionCard and capture the
    // user's answer. Reuses the normalized taskId/sessionId from above
    // so a caller that only sent metadata.taskId / metadata.sessionId
    // still produces a queue entry.
    if (data.type === 'question') {
      try {
        const queue = getDecisionQueue();
        const prompts = metadata.prompts ?? undefined;

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
      taskId,
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
