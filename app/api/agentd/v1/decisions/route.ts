/**
 * Decisions list endpoint (UI-facing).
 *
 * P0.2: The frontend's use-pending-decisions hook polls this route at
 * `/api/agentd/v1/decisions` and expects a flat array of snake_cased
 * decision records. Previously this route didn't exist, so the L2/ask
 * UI would silently 404 and never display anything.
 *
 * Returns active (pending + sent) decisions filtered by the user's
 * sessions. The richer `/l2/list` route returns the structured
 * {pending, sent} shape used by other callers.
 */

import { inArray } from 'drizzle-orm';
import { awaitRehydrated, getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { db } from '@/lib/core/db';
import { sessions } from '@/lib/core/db/schema';

const logger = createLogger('api.agentd.decisions.list');

export async function GET(request: Request) {
  try {
    await awaitRehydrated();
    const queue = getDecisionQueue();
    let pending = queue.listPending();
    let sent = queue.getSent();

    const userId = request.headers.get('x-user-id');
    if (userId) {
      const userSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.userId, [userId]));
      const sessionIds = new Set(userSessions.map((s) => s.id));
      pending = pending.filter((d) => sessionIds.has(d.sessionId));
      sent = sent.filter((d) => sessionIds.has(d.sessionId));
    }

    // Combine and convert to the snake_case shape the UI expects.
    const all = [...pending, ...sent];
    const data = all.map(decisionToSnake);

    logger.info('decisions listed', { count: data.length });

    return Response.json({ success: true, data });
  } catch (error) {
    logger.error('decisions list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Decisions list failed' },
      { status: 500 },
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decisionToSnake(d: any): Record<string, unknown> {
  return {
    decision_id: d.decisionId,
    type: d.type,
    task_id: d.taskId,
    session_id: d.sessionId,
    agent_id: d.agentId,
    node_id: d.nodeId,
    command: d.command,
    score: d.score,
    reason: d.reason,
    question: d.question,
    options: d.options,
    prompts: d.prompts,
    conflict: d.conflict,
    branch: d.branch,
    status: d.status,
    created_at: d.createdAt,
    timeout_at: d.timeoutAt,
    resolved_at: d.resolvedAt,
    action: d.action,
    answers: d.answers,
  };
}
