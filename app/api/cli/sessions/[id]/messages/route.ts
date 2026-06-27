import { withCliAuth } from '@/lib/cli/auth';
import { deserializePersistedMessages } from '@/lib/chat/persistence';
import { getSession, getVisibleSessionMessages } from '@/lib/core/db/chat';

/**
 * GET /api/cli/sessions/[id]/messages
 *
 * Returns the visible message history of a session, serialized as
 * UIMessage[]. The caller must own the session (canAccessOwnedResource
 * check). Channel-lock is intentionally NOT applied here: CLI reading
 * its own session's history is fine; cross-channel reads (e.g. CLI
 * loading a web session) are read-only and harmless — the channel lock
 * (commit 290eb33) already blocks writes on /api/cli/chat.
 */
export const GET = withCliAuth(async (request, ctx) => {
  const url = new URL(request.url);
  // Route under /api/cli/sessions/[id]/messages — extract [id] from path.
  const match = url.pathname.match(/\/api\/cli\/sessions\/([^/]+)\/messages$/);
  const sessionId = match?.[1];
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }

  const session = await getSession(sessionId);
  if (!session) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  // Owner-or-admin check (same as the web chat detail page).
  if (session.userId !== ctx.userId) {
    return Response.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  const messages = await getVisibleSessionMessages(sessionId);
  const uiMessages = deserializePersistedMessages(messages);

  return Response.json({
    ok: true,
    session: {
      id: session.id,
      title: session.title,
      channel: session.channel,
      model: session.model,
    },
    messages: uiMessages,
  });
});
