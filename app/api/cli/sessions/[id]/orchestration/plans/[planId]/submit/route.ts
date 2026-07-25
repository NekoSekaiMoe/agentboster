import { withCliAuth } from '@/lib/cli/auth';
import { getSession } from '@/lib/core/db/chat';
import {
  assertCanAccessPlan,
  getPlan,
  markPlanSubmitted,
  synthesizePlanInstruction,
} from '@/lib/core/db/agent-orchestration-plans';

/**
 * POST /api/cli/sessions/:id/orchestration/plans/:planId/submit
 *
 * Finalize a plan: synthesize the fan-out instruction text and mark the
 * plan as submitted. Does NOT post the message itself — the CLI takes the
 * returned `instruction` and sends it via /api/cli/chat as a normal user
 * message, so submission looks identical to the user typing it. This keeps
 * the API endpoint free of chat-trigger logic and mirrors the web
 * submitPlanAction server action exactly (same DAL, same contract).
 *
 * Body (optional):
 *   { submittedMessageId?: string }
 * If the CLI already knows the messageId it will use for the chat message
 * (e.g. an idempotency id), it can pass it here; otherwise leave empty and
 * the field is set to '' (filled later by the web side if needed).
 *
 * Returns:
 *   { ok: true, instruction: string, sessionId: string }
 */
export const POST = withCliAuth(async (request, ctx) => {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/orchestration\/plans\/([^/]+)\/submit(?:\?|$)/,
  );
  const sessionId = match?.[1] ?? null;
  const planId = match?.[2] ?? null;
  if (!sessionId || !planId) {
    return Response.json(
      { ok: false, error: 'Missing session id or plan id.' },
      { status: 400 },
    );
  }

  // Session ownership check.
  const session = await getSession(sessionId);
  if (!session || session.userId !== ctx.userId) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }
  // Plan must belong to this session.
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
  if (plan.items.length === 0) {
    return Response.json(
      { ok: false, error: 'Cannot submit an empty plan.' },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    submittedMessageId?: unknown;
  };
  const submittedMessageId =
    typeof body.submittedMessageId === 'string' ? body.submittedMessageId : '';

  const instruction = synthesizePlanInstruction(plan);
  await markPlanSubmitted(planId, submittedMessageId);

  return Response.json({ ok: true, instruction, sessionId });
});
