import { withCliAuth } from '@/lib/cli/auth';
import { getSession } from '@/lib/core/db/chat';
import {
  createPlan,
  listPlansBySession,
} from '@/lib/core/db/agent-orchestration-plans';

/**
 * CLI-facing orchestration plan API. Mirrors the Web ServerActions in
 * app/(orchestration)/actions.ts but authenticates via the CLI Bearer token
 * (withCliAuth) instead of the session cookie. Both surfaces call the same
 * pure DAL functions in lib/core/db/agent-orchestration-plans.ts, so behavior
 * stays identical — only the transport differs.
 *
 *   GET    /api/cli/sessions/:id/orchestration/plans         → list draft plans
 *   POST   /api/cli/sessions/:id/orchestration/plans         → create a plan
 *
 * Per-plan mutations live under:
 *   .../plans/:planId       (GET / PATCH / DELETE=archive)
 *   .../plans/:planId/submit (POST → returns synthesized instruction)
 *   .../plans/:planId/items (POST → add item)
 *
 * Auth model: every operation verifies the session is owned by the CLI
 * token's userId (same check as /api/cli/sessions/[id]). A plan is always
 * scoped to a session, so session ownership implies plan ownership.
 */

function getSessionIdFromUrl(request: Request): string | null {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/orchestration\/plans(?:\?|$)/,
  );
  return match?.[1] ?? null;
}

// Resolve + ownership-check the session. Returns a Response on failure so
// callers can `return` it directly; returns null when access is allowed.
async function guardSessionOwned(
  sessionId: string,
  userId: string,
): Promise<Response | null> {
  const session = await getSession(sessionId);
  if (!session || session.userId !== userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }
  return null;
}

export const GET = withCliAuth(async (request, ctx) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }
  const guard = await guardSessionOwned(sessionId, ctx.userId);
  if (guard) return guard;
  const plans = await listPlansBySession(sessionId);
  return Response.json({ ok: true, plans });
});

export const POST = withCliAuth(async (request, ctx) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }
  const guard = await guardSessionOwned(sessionId, ctx.userId);
  if (guard) return guard;
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    description?: unknown;
  } | null;
  if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
    return Response.json(
      { ok: false, error: 'title (non-empty string) is required.' },
      { status: 400 },
    );
  }
  const plan = await createPlan({
    sessionId,
    title: body.title,
    description: typeof body.description === 'string' ? body.description : null,
  });
  return Response.json({ ok: true, plan }, { status: 201 });
});
