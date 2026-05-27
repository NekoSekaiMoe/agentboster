/**
 * L2 Authorization List Endpoint
 * Returns all pending L2 decisions for the web UI
 */

import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l2.list');

export async function GET() {
  try {
    const queue = getDecisionQueue();
    const pending = queue.listPending();
    const sent = queue.getSent();

    logger.info('l2 decisions listed', {
      pending: pending.length,
      sent: sent.length,
    });

    return Response.json({
      success: true,
      data: {
        pending,
        sent,
      },
    });
  } catch (error) {
    logger.error('l2 list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'L2 list failed',
      },
      { status: 500 },
    );
  }
}
