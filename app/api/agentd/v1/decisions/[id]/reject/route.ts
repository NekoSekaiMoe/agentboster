/**
 * Decision reject endpoint (UI-facing).
 *
 * P0.2: Frontend posts here when user clicks "Ignore" on a question
 * decision (decision-card.tsx:659). Previously this route didn't exist
 * so the ignore button silently failed.
 *
 * Marks the decision denied (terminal) and forwards a rejection to the
 * daemon for L2 auth decisions so the agent loop doesn't wait the full
 * timeout.
 */

import { forwardL2Confirm } from '@/lib/extra/agent/agentd-client';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.decisions.reject');

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: decisionId } = await context.params;
    const queue = getDecisionQueue();
    const decision = queue.get(decisionId);

    if (!decision) {
      logger.warn('decision not in cache', { decisionId });
      return Response.json(
        { success: false, error: 'Decision not found' },
        { status: 404 },
      );
    }

    // Try to read optional user_id from body (the UI sends nothing by
    // default for the reject button; be defensive).
    let userId = 'user';
    try {
      const body = await request.json().catch(() => ({}));
      if (body && typeof body.user_id === 'string') userId = body.user_id;
    } catch {
      // body was empty — that's fine
    }

    await queue.deny(decisionId, userId);

    logger.info('decision rejected', {
      decisionId,
      type: decision.type,
    });

    // Forward rejection to daemon for L2 auth (saves a timeout wait).
    if (decision.type === 'l2_auth') {
      try {
        await forwardL2Confirm({
          task_id: decision.taskId,
          decision_id: decisionId,
          action: 'reject_once',
        });
      } catch (err) {
        logger.warn('forward to daemon failed; rejection still recorded', {
          decisionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return Response.json({ success: true, data: { decisionId } });
  } catch (error) {
    logger.error('decision reject failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Reject failed' },
      { status: 500 },
    );
  }
}
