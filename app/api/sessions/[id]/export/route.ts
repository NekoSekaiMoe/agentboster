import { requireAuthAccess } from '@/lib/auth/access';
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
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // Ownership check: a logged-in user must not be able to export another
  // user's session just by knowing its id. Admins may export any session.
  if (!access.isAdmin && session.userId !== access.session.userId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
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
