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

import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { sendAdapterSourceReply } from '@/lib/bot/reply';
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
    nodeId: undefined,
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

  // 3. Push to IM channel if source is provided.
  let messageId = '';
  if (isIM && source) {
    try {
      const text = formatL2PromptForIM({
        title: data.title,
        command: data.command,
        reason: data.reason,
        level: data.level,
        options: data.options,
      });
      const sent = await sendAdapterSourceReply(source, text);
      if (sent) {
        // We don't get the message id back from the adapter reply API.
        // The daemon uses message_id for recall; if absent it skips
        // recall, which is acceptable.
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
      channel: isIM && source ? source.adapter : 'in-app',
      message_id: messageId,
    },
  });
}

function formatL2PromptForIM(opts: {
  title: string;
  command: string;
  reason?: string;
  level: string;
  options?: string[];
}): string {
  const lines: string[] = [`⚠️ ${opts.title}`];
  if (opts.command) lines.push(``, `Command:`, '```', opts.command, '```');
  if (opts.reason)
    lines.push(``, `Reason: ${opts.reason}`, `Risk: ${opts.level}`);
  if (opts.options && opts.options.length > 0) {
    lines.push(``, `Open the dashboard to choose: ${opts.options.join(', ')}`);
  }
  return lines.join('\n');
}
