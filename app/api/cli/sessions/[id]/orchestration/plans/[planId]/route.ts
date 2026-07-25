import { withCliAuth } from '@/lib/cli/auth';
import { getSession } from '@/lib/core/db/chat';
import {
  archivePlan,
  assertCanAccessPlan,
  getPlan,
  markPlanSubmitted,
  synthesizePlanInstruction,
  updatePlan,
} from '@/lib/core/db/agent-orchestration-plans';

/**
 * Per-plan operations for the CLI orchestration API.
 *
 *   GET    .../plans/:planId        → read plan + items
 *   PATCH  .../plans/:planId        → update title/description
 *   DELETE .../plans/:planId        → archive (soft-delete)
 *   POST   .../plans/:planId/submit → mark submitted + return instruction
 *
 * Ownership: a plan is always scoped to a session. We resolve the plan,
 * verify it belongs to the URL's sessionId, then verify the session is owned
 * by the CLI token's userId — same two-level check the web ServerActions do
 * (requireSessionOwned + assertCanAccessPlan).
 */

interface UrlParts {
  sessionId: string | null;
  planId: string | null;
}

function parseUrl(request: Request): UrlParts {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/orchestration\/plans\/([^/]+)(?:\/|$|\?)/,
  );
  return { sessionId: match?.[1] ?? null, planId: match?.[2] ?? null };
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
  const { sessionId, planId } = parseUrl(request);
  if (!sessionId || !planId) {
    return Response.json(
      { ok: false, error: 'Missing session id or plan id.' },
      { status: 400 },
    );
  }
  const guard = await guardSessionOwned(sessionId, ctx.userId);
  if (guard) return guard;
  // Verify the plan belongs to this session (throws on mismatch).
  try {
    await assertCanAccessPlan(planId, sessionId);
  } catch {
    return Response.json(
      { ok: false, error: 'Plan not found for this session.' },
      { status: 404 },
    );
  }
  const plan = await getPlan(planId);
  if (!plan) {
    return Response.json(
      { ok: false, error: 'Plan not found.' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, plan });
});

export const PATCH = withCliAuth(async (request, ctx) => {
  const { sessionId, planId } = parseUrl(request);
  if (!sessionId || !planId) {
    return Response.json(
      { ok: false, error: 'Missing session id or plan id.' },
      { status: 400 },
    );
  }
  const guard = await guardSessionOwned(sessionId, ctx.userId);
  if (guard) return guard;
  try {
    await assertCanAccessPlan(planId, sessionId);
  } catch {
    return Response.json(
      { ok: false, error: 'Plan not found for this session.' },
      { status: 404 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    description?: unknown;
  } | null;
  if (!body) {
    return Response.json(
      { ok: false, error: 'Invalid JSON body.' },
      { status: 400 },
    );
  }
  const patch: { title?: string; description?: string | null } = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.description === 'string' || body.description === null) {
    patch.description = body.description;
  }
  if (Object.keys(patch).length === 0) {
    return Response.json(
      { ok: false, error: 'No updatable fields.' },
      { status: 400 },
    );
  }
  const plan = await updatePlan(planId, patch);
  return Response.json({ ok: true, plan });
});

export const DELETE = withCliAuth(async (request, ctx) => {
  const { sessionId, planId } = parseUrl(request);
  if (!sessionId || !planId) {
    return Response.json(
      { ok: false, error: 'Missing session id or plan id.' },
      { status: 400 },
    );
  }
  const guard = await guardSessionOwned(sessionId, ctx.userId);
  if (guard) return guard;
  try {
    await assertCanAccessPlan(planId, sessionId);
  } catch {
    return Response.json(
      { ok: false, error: 'Plan not found for this session.' },
      { status: 404 },
    );
  }
  await archivePlan(planId);
  return Response.json({ ok: true });
});
