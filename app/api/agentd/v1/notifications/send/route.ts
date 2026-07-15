/**
 * Send notification endpoint (daemon → web → IM).
 *
 * P0.3: agentd's dispatcher L2-auth flow POSTs here with the full
 * decision payload (command, score, options, source). Previously this
 * route didn't exist, so all L2 authorization prompts to IM channels
 * failed silently and agents would hang forever waiting for a reply.
 *
 * Responsibilities:
 *   1. Persist the decision to the notifications table.
 *   2. Mirror into the L2 decision queue so the chat UI can render it.
 *   3. If the request has an IM `source`, push the prompt to the IM
 *      channel via the bot adapter and return the sent message_id so
 *      the daemon can recall it later (dispatcher.go:583).
 */

export const dynamic = 'force-dynamic';

import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { sendNotification } from '@/lib/extra/channels/send-notification';
import {
  DecisionStatus,
  DecisionType,
  type Decision,
} from '@/lib/security/l2-decision-queue';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { chatSourceSchema } from '@/types/workflow';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.notifications.send');

const requestSchema = z.object({
  type: z.string().default('decision'),
  task_id: z.string(),
  taskId: z.string().optional(),
  decisionId: z.string().optional(),
  title: z.string().default('Authorization required'),
  // Optional i18n key (e.g. 'agentd.notify.l2Required') — when set,
  // send-notification translates it server-side using the resolved
  // user locale. Falls back to `title` if the key is missing.
  titleKey: z.string().optional(),
  titleValues: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional(),
  body: z.string().default(''),
  command: z.string().default(''),
  command_review: z.any().optional(),
  commandReview: z.any().optional(),
  score: z.number().optional(),
  reason: z.string().optional(),
  level: z.string().default('high'),
  source: chatSourceSchema.optional(),
  options: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  message: z.any().optional(),
  // Node id of the agentd daemon that raised this L2 authorization.
  // Persisted on the decision so the user's verdict is later routed back
  // to *this* daemon (which holds the paused task + L2AuthManager cache)
  // rather than to nodes[0]. Optional — older daemons don't send it, in
  // which case the forward falls back to default single-node resolution.
  node_id: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: 'Invalid send-notification request',
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const taskId = data.taskId || data.task_id;
  const decisionId = data.decisionId ?? `${taskId}:${Date.now()}`;

  logger.info('notification send requested', {
    decisionId,
    taskId,
    hasSource: !!data.source,
  });

  // 1. Enqueue into the decision queue (DB-backed via P0.2).
  const source = data.source;
  const isIM = source?.type === 'im';
  const sessionId = (isIM ? source.threadId : undefined) ?? taskId; // fallback so the row is at least findable
  const expiresAt = data.expiresAt
    ? new Date(data.expiresAt)
    : new Date(Date.now() + 3 * 60 * 1000);

  const decision: Decision = {
    decisionId,
    type: DecisionType.L2_AUTH,
    taskId,
    sessionId,
    agentId: undefined,
    command: data.command,
    score: data.score,
    reason: data.reason,
    options: data.options,
    status: DecisionStatus.PENDING,
    nodeId: data.node_id,
    createdAt: new Date(),
    timeoutAt: expiresAt,
  };

  try {
    const queue = getDecisionQueue();
    await queue.enqueue(decision);
  } catch (err) {
    logger.warn('failed to enqueue L2 decision; continuing with IM send', {
      decisionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Persist to notifications table.
  try {
    await db.insert(notifications).values({
      taskId,
      decisionId,
      notificationType: 'decision',
      payload: {
        type: data.type,
        title: data.title,
        body: data.body,
        command: data.command,
        score: data.score,
        reason: data.reason,
        level: data.level,
        options: data.options,
        expiresAt: data.expiresAt,
      },
      status: 'pending',
      channel: isIM ? source.adapter : 'in-app',
      targetChatId: isIM ? source.threadId : sessionId,
      targetUserId: isIM ? (source.userId ?? null) : null,
      expiresAt,
    });
  } catch (err) {
    logger.warn('failed to persist notification', {
      decisionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Push to IM channel if source is provided. Use the canonical
  // sendNotification helper (was sendAdapterSourceReply in initial P0.3,
  // which skipped preference/fallback handling). sendNotification
  // already understands the 'decision' payload type via the
  // NotificationManager.sendL2Decision path.
  let messageId = '';
  let channel = isIM && source ? source.adapter : 'in-app';
  if (isIM && source) {
    try {
      const result = await sendNotification({
        source,
        userId: source.userId ?? undefined,
        payload: {
          type: 'decision' as const,
          taskId,
          decisionId,
          title: data.title,
          body: data.body,
          command: data.command,
          commandReview: data.commandReview ?? '',
          score: data.score ?? 0,
          reason: data.reason ?? '',
          options: (data.options ?? [
            'pass_once',
            'pass_until',
            'reject_once',
            'reject_until',
          ]) as never,
          expiresAt: expiresAt.toISOString(),
          // Phase 4: forward optional titleKey for server-side localization
          ...(data.titleKey
            ? { titleKey: data.titleKey, titleValues: data.titleValues }
            : {}),
        } as never,
      });
      channel = result.channel;
      if (result.success && result.messageId) {
        messageId = result.messageId;
      } else if (result.success) {
        messageId = `sent_${Date.now()}`;
      }
    } catch (err) {
      logger.warn('IM send failed; decision still in queue', {
        decisionId,
        adapter: source.adapter,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    success: true,
    data: {
      channel,
      message_id: messageId,
    },
  });
}
