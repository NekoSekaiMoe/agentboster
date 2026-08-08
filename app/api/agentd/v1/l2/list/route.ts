/**
 * L2 Authorization List Endpoint
 * Returns all pending L2 decisions for the web UI
 */

export const dynamic = 'force-dynamic';

import { inArray } from 'drizzle-orm';
import { awaitRehydrated, getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { db } from '@/lib/core/db';
import { sessions } from '@/lib/core/db/schema';

const logger = createLogger('api.agentd.l2.list');

export async function GET(request: Request) {
  try {
    // Make sure the cache has been populated from the DB at least once.
    // The first call across a fresh instance is slow (one DB round-trip),
    // subsequent calls are in-memory.
    await awaitRehydrated();
    const queue = getDecisionQueue();

    // This route is UI-facing and MUST be scoped to one user. proxy.ts
    // injects `x-user-id` on session-authenticated requests; requests
    // admitted via AGENTD_API_KEY carry no user identity and must NOT
    // enumerate every user's pending L2 authorizations. Treating the
    // header as optional (the prior behavior) leaked all users'
    // decisions to any AGENTD_API_KEY holder.
    const userId = request.headers.get('x-user-id');
    if (!userId) {
      return Response.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      );
    }

    const userSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.userId, [userId]));
    const sessionIds = new Set(userSessions.map((s) => s.id));
    const pending = queue.listPending().filter((d) => sessionIds.has(d.sessionId));
    const sent = queue.getSent().filter((d) => sessionIds.has(d.sessionId));

    logger.info('l2 decisions listed', {
      userId,
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
