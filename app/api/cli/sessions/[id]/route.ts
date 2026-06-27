import { withCliAuth } from '@/lib/cli/auth';
import { getSession, updateSessionForUser } from '@/lib/core/db/chat';

export const PATCH = withCliAuth(async (request, ctx) => {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/api\/cli\/sessions\/([^/]+)$/);
  const sessionId = match?.[1];
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }

  const body = (await request.json()) as { model?: string | null };
  const session = await getSession(sessionId);
  if (!session) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  const next = await updateSessionForUser(sessionId, ctx.userId, {
    model: body.model ?? null,
  });
  if (!next) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, session: next });
});
