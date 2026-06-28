import { db } from '@/lib/core/db';
import { messages } from '@/lib/core/db/schema/chat';
import { withCliAuth } from '@/lib/cli/auth';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

/**
 * POST /api/cli/sessions/[id]/compact
 *
 * Apply a compaction result from the CLI. Deletes all messages before
 * the given uiMessageId, then inserts a single 'summary' message with
 * the compaction summary text.
 *
 * Body: { summary: string, firstKeptUiMessageId: string }
 */
const requestSchema = z.object({
  summary: z.string().min(1),
  firstKeptUiMessageId: z.string().min(1),
});

export const POST = withCliAuth(async (request, _ctx) => {
  const match = request.url.match(/\/api\/cli\/sessions\/([^/]+)\/compact$/);
  const sessionId = match?.[1];
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }

  const body = requestSchema.parse(await request.json());

  // Find the kept message's createdAt to determine the cutoff.
  const [kept] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.uiMessageId, body.firstKeptUiMessageId),
      ),
    )
    .limit(1);

  if (!kept) {
    return Response.json(
      { ok: false, error: 'firstKeptUiMessageId not found' },
      { status: 404 },
    );
  }

  // Delete all messages older than the kept message.
  await db
    .delete(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        lt(messages.createdAt, kept.createdAt),
      ),
    );

  // Insert the compaction summary as a 'summary' role message.
  await db.insert(messages).values({
    sessionId,
    role: 'summary',
    uiMessageId: `compact-${Date.now()}`,
    payload: {
      type: 'compaction-summary',
      summary: body.summary,
      timestamp: Date.now(),
    },
  });

  return Response.json({ ok: true });
});
