import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { getSession, getVisibleSessionMessages } from '@/lib/core/db/chat';
import { deserializePersistedMessages } from '@/lib/chat/persistence';
import { listSessionSummaries } from '@/lib/memory/session';
import { cookies } from 'next/headers';

/**
 * Response headers for exports of private data. These payloads contain a
 * user's session messages/summaries, so they must never be cached by the
 * browser, a shared proxy, or a CDN.
 */
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch (error) {
    // Only map explicit auth failures to their status; let anything else
    // (e.g. a DB error inside requireAuthAccess) bubble up as a 5xx.
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const { id: sessionId } = await params;
  const session = await getSession(sessionId);

  // Collapse "not found" and "exists but not yours" into a single 404 so a
  // logged-in user cannot probe which session ids exist by diffing 403 vs
  // 404. Admins may export any session.
  if (
    !session ||
    (!access.isAdmin && session.userId !== access.session.userId)
  ) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const [messageRows, summaries] = await Promise.all([
    getVisibleSessionMessages(sessionId),
    listSessionSummaries(sessionId),
  ]);

  const uiMessages = deserializePersistedMessages(messageRows);

  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 1,
    session: {
      id: session.id,
      title: session.title,
      channel: session.channel,
      model: session.model,
      status: session.status,
      systemPrompt: session.systemPrompt,
      totalTokens: session.totalTokens,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messages: uiMessages,
    summaries: summaries.map((s) => ({
      version: s.summaryVersion,
      isCurrent: s.isCurrent,
      content: s.content,
      createdAt: s.createdAt,
    })),
  };

  const filename = `session-${sessionId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...NO_STORE_HEADERS,
    },
  });
}
