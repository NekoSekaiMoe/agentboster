import { withCliAuth } from '@/lib/cli/auth';
import { db } from '@/lib/core/db';
import { messages, sessions } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { chatMessageMetadataSchema } from '@/types/workflow';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const logger = createLogger('api.cli.messages.metadata');

const requestSchema = z.object({
  sessionId: z.string(),
  metadata: chatMessageMetadataSchema,
});

function getMessageIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/messages\/([^/]+)\/metadata$/);
  return match?.[1] ?? null;
}

/**
 * PATCH /api/cli/messages/[messageId]/metadata
 *
 * CLI mirror of the web's `PATCH /api/messages/[messageId]/metadata`.
 * Writes `metadata` (editHistory / generationHistory / currentEditIndex /
 * currentGenerationIndex) into the messages.payload jsonb, identified by
 * `uiMessageId`.
 *
 * Unlike the web route (cookie auth, no ownership check), this verifies
 * the message's owning session belongs to the authenticated CLI user.
 */
export const PATCH = withCliAuth(async (request, ctx) => {
  const messageId = getMessageIdFromUrl(request);
  if (!messageId) {
    return Response.json(
      { ok: false, error: 'Missing message id.' },
      { status: 400 },
    );
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    logger.error('patch:parse_failed', { messageId, error });
    return Response.json(
      { ok: false, error: 'Invalid request body.' },
      { status: 400 },
    );
  }

  try {
    const [currentMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.uiMessageId, messageId))
      .limit(1);

    if (!currentMessage) {
      return Response.json(
        { ok: false, error: 'Message not found.' },
        { status: 404 },
      );
    }

    // Ownership: the message's session must belong to the CLI user.
    // The body's sessionId is the caller's claim; the row's sessionId is
    // the truth. They must match and the session must be owned by ctx.userId.
    if (currentMessage.sessionId !== body.sessionId) {
      return Response.json(
        { ok: false, error: 'Session id mismatch.' },
        { status: 403 },
      );
    }

    const [session] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, body.sessionId))
      .limit(1);

    if (!session || session.userId !== ctx.userId) {
      return Response.json(
        { ok: false, error: 'Session not found.' },
        { status: 404 },
      );
    }

    const updatedPayload = {
      ...(currentMessage.payload as Record<string, unknown>),
      metadata: body.metadata,
    };

    await db
      .update(messages)
      .set({ payload: updatedPayload })
      .where(eq(messages.uiMessageId, messageId));

    logger.info('patch:success', {
      messageId,
      metadataKeys: Object.keys(body.metadata),
    });
    return Response.json({ ok: true });
  } catch (error) {
    logger.error('patch:update_failed', { messageId, error });
    return Response.json(
      { ok: false, error: 'Failed to update message metadata.' },
      { status: 500 },
    );
  }
});
