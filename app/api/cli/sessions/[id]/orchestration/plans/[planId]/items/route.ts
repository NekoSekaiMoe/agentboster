import { withCliAuth } from '@/lib/cli/auth';
import { getSession } from '@/lib/core/db/chat';
import {
  addPlanItem,
  assertCanAccessPlan,
  removePlanItem,
  updatePlanItem,
} from '@/lib/core/db/agent-orchestration-plans';

/**
 * Plan item operations for the CLI orchestration API.
 *
 *   POST   .../plans/:planId/items           → add an item
 *   PATCH  .../plans/:planId/items/:itemId   → update an item
 *   DELETE .../plans/:planId/items/:itemId   → soft-remove an item
 *
 * Ownership: resolve plan → assert it belongs to the URL's session → assert
 * the session is owned by the CLI token's userId. Two-level check identical
 * to the web ServerActions.
 */

interface UrlParts {
  sessionId: string | null;
  planId: string | null;
  itemId: string | null;
}

function parseUrl(request: Request): UrlParts {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/orchestration\/plans\/([^/]+)\/items(?:\/([^/]+))?(?:\?|$)/,
  );
  return {
    sessionId: match?.[1] ?? null,
    planId: match?.[2] ?? null,
    itemId: match?.[3] ?? null,
  };
}

async function guardPlanOwned(
  sessionId: string,
  planId: string,
  userId: string,
): Promise<Response | null> {
  const session = await getSession(sessionId);
  if (!session || session.userId !== userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }
  try {
    await assertCanAccessPlan(planId, sessionId);
  } catch {
    return Response.json(
      { ok: false, error: 'Plan not found for this session.' },
      { status: 404 },
    );
  }
  return null;
}

export const POST = withCliAuth(async (request, ctx) => {
  const { sessionId, planId, itemId } = parseUrl(request);
  if (!sessionId || !planId || itemId) {
    // itemId must be absent for the collection POST.
    return Response.json(
      { ok: false, error: 'Missing session id or plan id.' },
      { status: 400 },
    );
  }
  const guard = await guardPlanOwned(sessionId, planId, ctx.userId);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    agentName?: unknown;
    task?: unknown;
    dependsOn?: unknown;
    order?: unknown;
  } | null;
  if (
    !body ||
    typeof body.agentName !== 'string' ||
    typeof body.task !== 'string'
  ) {
    return Response.json(
      { ok: false, error: 'agentName and task (strings) are required.' },
      { status: 400 },
    );
  }
  const dependsOn =
    Array.isArray(body.dependsOn) &&
    body.dependsOn.every((d) => typeof d === 'string')
      ? (body.dependsOn as string[])
      : undefined;
  const order = typeof body.order === 'number' ? body.order : undefined;

  const item = await addPlanItem({
    planId,
    agentName: body.agentName,
    task: body.task,
    dependsOn,
    order,
  });
  return Response.json({ ok: true, item }, { status: 201 });
});

export const PATCH = withCliAuth(async (request, ctx) => {
  const { sessionId, planId, itemId } = parseUrl(request);
  if (!sessionId || !planId || !itemId) {
    return Response.json(
      { ok: false, error: 'Missing session id, plan id, or item id.' },
      { status: 400 },
    );
  }
  const guard = await guardPlanOwned(sessionId, planId, ctx.userId);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    agentName?: unknown;
    task?: unknown;
    dependsOn?: unknown;
    order?: unknown;
  } | null;
  if (!body) {
    return Response.json(
      { ok: false, error: 'Invalid JSON body.' },
      { status: 400 },
    );
  }
  const patch: {
    agentName?: string;
    task?: string;
    dependsOn?: string[];
    order?: number;
  } = {};
  if (typeof body.agentName === 'string') patch.agentName = body.agentName;
  if (typeof body.task === 'string') patch.task = body.task;
  if (
    Array.isArray(body.dependsOn) &&
    body.dependsOn.every((d) => typeof d === 'string')
  ) {
    patch.dependsOn = body.dependsOn as string[];
  }
  if (typeof body.order === 'number') patch.order = body.order;
  if (Object.keys(patch).length === 0) {
    return Response.json(
      { ok: false, error: 'No updatable fields.' },
      { status: 400 },
    );
  }

  // updatePlanItem takes the uuid planId, but the DAL signature is
  // (itemId, planId, patch) where planId is the stable text id resolved
  // internally — verify against our text planId by passing it through.
  const item = await updatePlanItem(itemId, planId, patch);
  if (!item) {
    return Response.json(
      { ok: false, error: 'Item not found.' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, item });
});

export const DELETE = withCliAuth(async (request, ctx) => {
  const { sessionId, planId, itemId } = parseUrl(request);
  if (!sessionId || !planId || !itemId) {
    return Response.json(
      { ok: false, error: 'Missing session id, plan id, or item id.' },
      { status: 400 },
    );
  }
  const guard = await guardPlanOwned(sessionId, planId, ctx.userId);
  if (guard) return guard;

  await removePlanItem(itemId, planId);
  return Response.json({ ok: true });
});
