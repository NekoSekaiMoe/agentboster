/**
 * L2 Authorization List Endpoint
 * Returns all pending L2 decisions for the web UI
 */

import { inArray } from 'drizzle-orm';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { db } from '@/lib/core/db';
import { sessions } from '@/lib/core/db/schema';

const logger = createLogger('api.agentd.l2.list');

export async function GET(request: Request) {
  try {
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
