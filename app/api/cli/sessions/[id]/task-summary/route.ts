import { withCliAuth } from '@/lib/cli/auth';
import { getTaskSummary, upsertTaskSummary } from '@/lib/core/db/agentd';
import { getSession } from '@/lib/core/db/chat';
import { z } from 'zod';

/**
 * GET /api/cli/sessions/[id]/task-summary
 *
 * Returns the current task summary row for the session's task id, or
 * { ok: true, summary: null } when none exists yet.
 */
export const GET = withCliAuth(async (request, ctx) => {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/task-summary$/,
  );
  const sessionId = match?.[1];
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

  // task_summaries.taskId historically mirrors the session id for CLI/Web
  // agent loops (see lib/workflow/agent/tools/tasks/summary.ts which uses
  // sessionId as the task id).
  const summary = await getTaskSummary(sessionId);
  return Response.json({ ok: true, summary });
});

const patchSchema = z.object({
  progress: z.string().min(1).optional(),
  pendingAdd: z.array(z.string()).optional(),
  pendingDone: z.array(z.string()).optional(),
  knownIssueAdd: z.array(z.string()).optional(),
  knownIssueResolve: z.array(z.string()).optional(),
  decision: z
    .object({
      description: z.string().min(1),
      reason: z.string().min(1),
      alternatives: z.array(z.string()).default([]),
    })
    .optional(),
});

/**
 * PATCH /api/cli/sessions/[id]/task-summary
 *
 * Apply a delta update to the session's task summary. Mirrors the shape
 * of the Web agent's `task_progress` tool so the CLI tool can share the
 * same schema.
 */
export const PATCH = withCliAuth(async (request, ctx) => {
  const match = request.url.match(
    /\/api\/cli\/sessions\/([^/]+)\/task-summary$/,
  );
  const sessionId = match?.[1];
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

  const body = patchSchema.parse(await request.json().catch(() => ({})));

  const existing = await getTaskSummary(sessionId);
  const removeItems = (
    items: string[] | null | undefined,
    removals: string[] | undefined,
  ) => {
    if (!removals?.length) return items ?? [];
    const set = new Set(removals);
    return (items ?? []).filter((i) => !set.has(i));
  };

  const decisions = existing?.decisions ?? [];
  if (body.decision) {
    decisions.push({
      id: `dec_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      description: body.decision.description,
      reason: body.decision.reason,
      alternatives: body.decision.alternatives,
    });
  }

  const updated = await upsertTaskSummary({
    taskId: sessionId,
    agentId: 'cli',
    sessionId,
    status: existing?.status ?? 'active',
    progress: body.progress ?? existing?.progress ?? undefined,
    decisions,
    pending: [
      ...removeItems(existing?.pending, body.pendingDone),
      ...(body.pendingAdd ?? []),
    ],
    knownIssues: [
      ...removeItems(existing?.knownIssues, body.knownIssueResolve),
      ...(body.knownIssueAdd ?? []),
    ],
  });

  return Response.json({ ok: true, summary: updated });
});
