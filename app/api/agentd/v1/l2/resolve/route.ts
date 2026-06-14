/**
 * L2 Authorization Resolve Endpoint
 * Called by web UI when user approves or rejects an L2 request.
 *
 * P0.2: Now persists resolution to DB and forwards the decision back
 * to the originating agentd node via forwardL2Confirm. Previously
 * this had a TODO that left the daemon hanging forever.
 */

import { forwardL2Confirm } from '@/lib/extra/agent/agentd-client';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.l2.resolve');

const requestSchema = z.object({
  decision_id: z.string(),
  action: z.enum(['pass', 'reject']),
  duration: z.string().default('once'),
  resolved_by: z.string().default('user'),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      logger.error('invalid request', { error: parsed.error });
      return Response.json(
        {
          success: false,
          error: 'Invalid request',
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const queue = getDecisionQueue();
    const decision = queue.get(parsed.data.decision_id);

    if (!decision) {
      logger.error('decision not found', {
        decisionId: parsed.data.decision_id,
      });
      return Response.json(
        {
          success: false,
          error: 'Decision not found',
        },
        { status: 404 },
      );
    }

    const action = parsed.data.action;
    if (action === 'pass') {
      await queue.resolve(
        parsed.data.decision_id,
        `pass:${parsed.data.duration}`,
        parsed.data.resolved_by,
      );
    } else {
      await queue.deny(parsed.data.decision_id, parsed.data.resolved_by);
    }

    logger.info('l2 decision resolved', {
      decisionId: parsed.data.decision_id,
      taskId: decision.taskId,
      action,
      duration: parsed.data.duration,
      resolvedBy: parsed.data.resolved_by,
    });

    // Forward to the originating daemon so it can unblock the task.
    // Use the daemon action vocabulary the /api/v1/l2-confirm handler
    // understands: pass_once | pass_until | reject_once | reject_until.
    const daemonAction =
      action === 'pass'
        ? parsed.data.duration === 'always'
          ? 'pass_until'
          : 'pass_once'
        : parsed.data.duration === 'always'
          ? 'reject_until'
          : 'reject_once';

    try {
      await forwardL2Confirm({
        task_id: decision.taskId,
        decision_id: decision.decisionId,
        action: daemonAction,
        duration: parsed.data.duration,
      });
    } catch (err) {
      // Don't fail the whole request — the user has already seen
      // success. The daemon will retry or time out on its own.
      logger.warn('forward to daemon failed; decision still recorded', {
        decisionId: decision.decisionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return Response.json({
      success: true,
      data: {
        decisionId: parsed.data.decision_id,
        action,
      },
    });
  } catch (error) {
    logger.error('l2 resolve failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'L2 resolve failed',
      },
      { status: 500 },
    );
  }
}
