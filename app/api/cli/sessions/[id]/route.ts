import { withCliAuth } from '@/lib/cli/auth';
import { cleanupChatSession } from '@/lib/chat/session-cleanup';
import { getSession, updateSessionForUser } from '@/lib/core/db/chat';

function getSessionIdFromUrl(request: Request): string | null {
  const match = request.url.match(/\/api\/cli\/sessions\/([^/]+)$/);
  return match?.[1] ?? null;
}

export const GET = withCliAuth(async (request, ctx) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }
  const session = await getSession(sessionId);
  if (!session || session.userId !== ctx.userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, session });
});

type SessionPatchBody = {
  model?: string | null;
  title?: string | null;
};

export const PATCH = withCliAuth(async (request, ctx) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as SessionPatchBody;
  const session = await getSession(sessionId);
  if (!session || session.userId !== ctx.userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  const patch: { model?: string | null; title?: string | null } = {};
  if (typeof body.model === 'string' || body.model === null) {
    patch.model = body.model ?? null;
  }
  if (typeof body.title === 'string' || body.title === null) {
    patch.title = body.title ?? null;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json(
      { ok: false, error: 'No updatable fields in patch body.' },
      { status: 400 },
    );
  }

  const next = await updateSessionForUser(sessionId, ctx.userId, patch);
  if (!next) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, session: next });
});

export const DELETE = withCliAuth(async (request, ctx) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }
  const session = await getSession(sessionId);
  if (!session || session.userId !== ctx.userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  const result = await cleanupChatSession(session, { userId: ctx.userId });
  return Response.json({ ok: true, ...result });
});
