import { canAccessOwnedResource, requireAuthAccess } from '@/lib/auth/access';
import { db, schema } from '@/lib/core/db';
import { getSession } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { chatMessageMetadataSchema } from '@/types/workflow';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const logger = createLogger('api.messages.metadata');

const requestSchema = z.object({
  sessionId: z.string(),
  metadata: chatMessageMetadataSchema,
});

/**
 * PATCH /api/messages/[messageId]/metadata
 *
 * Writes `metadata` (versions / currentVersionIndex) into the
 * messages.payload jsonb, identified by `uiMessageId`. Used by the web
 * chat client to persist edit/regenerate version history so it survives
 * page refresh. The CLI has its own mirror at
 * /api/cli/messages/[messageId]/metadata (mTLS + AGENTD_API_KEY).
 *
 * Ownership is verified twice: the message's session must match the
 * body's sessionId, and that session must belong to the authenticated
 * user (no trusting the client's sessionId claim on its own).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    logger.warn('patch:invalid_body', { messageId, error });
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400 },
    );
  }

  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [currentMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.uiMessageId, messageId))
      .limit(1);

    if (!currentMessage) {
      return NextResponse.json(
        { error: 'Message not found.' },
        { status: 404 },
      );
    }

    if (currentMessage.sessionId !== body.sessionId) {
      return NextResponse.json(
        { error: 'Session id mismatch.' },
        { status: 403 },
      );
    }

    const session = await getSession(body.sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found.' },
        { status: 404 },
      );
    }
    if (!canAccessOwnedResource(access, session.userId)) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    const updatedPayload = {
      ...(currentMessage.payload as Record<string, unknown>),
      metadata: body.metadata,
    };

    await db
      .update(schema.messages)
      .set({ payload: updatedPayload })
      .where(eq(schema.messages.uiMessageId, messageId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('patch:update_failed', { messageId, error });
    return NextResponse.json(
      { error: 'Failed to update message metadata.' },
      { status: 500 },
    );
  }
}
