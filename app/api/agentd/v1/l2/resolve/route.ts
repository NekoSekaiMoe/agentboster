/**
 * L2 Authorization Resolve Endpoint
 * Called by web UI when user approves or rejects an L2 request
 */

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

    if (parsed.data.action === 'pass') {
      queue.resolve(
        parsed.data.decision_id,
        `pass:${parsed.data.duration}`,
        parsed.data.resolved_by,
      );
    } else {
      queue.deny(parsed.data.decision_id, parsed.data.resolved_by);
    }

    logger.info('l2 decision resolved', {
      decisionId: parsed.data.decision_id,
      taskId: decision.taskId,
      action: parsed.data.action,
      duration: parsed.data.duration,
      resolvedBy: parsed.data.resolved_by,
    });

    // TODO: Push decision back to agentd via webhook
    // await pushDecisionToAgentd(decision, parsed.data.action, parsed.data.duration);

    return Response.json({
      success: true,
      data: {
        decisionId: parsed.data.decision_id,
        action: parsed.data.action,
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
