/**
 * L2 Authorization Request Endpoint
 * Called by agentd when L1 high-risk command needs user authorization
 */

import { getDecisionQueue } from '@/lib/security/l2-index';
import type { Decision } from '@/lib/security/l2-decision-queue';
import { DecisionStatus, DecisionType } from '@/lib/security/l2-decision-queue';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.l2.request');

const requestSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  command: z.string(),
  score: z.number(),
  reason: z.string(),
  level: z.enum(['high', 'critical']),
  agent_id: z.string(),
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

    const decision: Decision = {
      decisionId: `l2_${parsed.data.task_id}_${Date.now()}`,
      type: DecisionType.L2_AUTH,
      taskId: parsed.data.task_id,
      sessionId: parsed.data.session_id,
      command: parsed.data.command,
      score: parsed.data.score,
      reason: parsed.data.reason,
      status: DecisionStatus.PENDING,
      createdAt: new Date(),
      timeoutAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    };

    const promoted = queue.enqueue(decision);

    logger.info('l2 request received', {
      taskId: parsed.data.task_id,
      command: parsed.data.command,
      score: parsed.data.score,
      level: parsed.data.level,
      promoted,
    });

    return Response.json({
      success: true,
      data: {
        decisionId: decision.decisionId,
        promoted,
      },
    });
  } catch (error) {
    logger.error('l2 request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'L2 request failed',
      },
      { status: 500 },
    );
  }
}
