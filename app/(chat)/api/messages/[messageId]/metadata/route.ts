import { readAuthSessionFromCookies } from '@/lib/auth';
import { db } from '@/lib/core/db';
import { messages } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { chatMessageMetadataSchema } from '@/types/workflow';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { z } from 'zod';

const logger = createLogger('api.messages.metadata');

const requestSchema = z.object({
  sessionId: z.string(),
  metadata: chatMessageMetadataSchema,
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  logger.info('patch:start', { messageId });

  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    logger.error('patch:parse_failed', { error });
    return Response.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  try {
    // Update the message's metadata in the database
    const [updated] = await db
      .update(messages)
      .set({
        payload: db.raw(
          `
          jsonb_set(
            COALESCE(payload, '{}'::jsonb),
            '{metadata}',
            ?::jsonb
          )
        `,
          [JSON.stringify(body.metadata)],
        ),
      })
      .where(eq(messages.uiMessageId, messageId))
      .returning({ id: messages.id });

    if (!updated) {
      logger.error('patch:message_not_found', { messageId });
      return Response.json(
        { success: false, error: 'Message not found' },
        { status: 404 },
      );
    }

    logger.info('patch:success', {
      messageId,
      metadataKeys: Object.keys(body.metadata),
    });
    return Response.json({ success: true });
  } catch (error) {
    logger.error('patch:update_failed', { error });
    return Response.json(
      { success: false, error: 'Failed to update metadata' },
      { status: 500 },
    );
  }
}
