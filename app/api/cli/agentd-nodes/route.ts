/**
 * GET /api/cli/agentd-nodes
 *
 * Returns the agentd nodes the caller can pick from when scheduling a
 * Web task that should run on a specific daemon. This is a read-only
 * view over `agentd_nodes` shaped for the Desktop schedule form's
 * "preferred node" dropdown: id + a display label + computed effective
 * status (heartbeat-freshness-based, NOT the stored `status` column —
 * that column is only ever written 'online' and would otherwise show
 * dead nodes as available forever).
 *
 * Distinct from `/api/agentd/v1/nodes/status`: that route is daemon-
 * facing (mTLS + AGENTD_API_KEY) and exposes raw diagnostic fields.
 * This route is user-facing, behind `withCliAuth`, and only returns
 * the picker-relevant subset.
 */

export const dynamic = 'force-dynamic';

import { withCliAuth } from '@/lib/cli/auth';
import { computeNodeStatus } from '@/lib/extra/agent/node-liveness';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { desc } from 'drizzle-orm';

const logger = createLogger('api.cli.agentd-nodes');

export const GET = withCliAuth(async (_req, _ctx) => {
  try {
    const rows = await db
      .select()
      .from(agentdNodes)
      .orderBy(desc(agentdNodes.lastHeartbeat))
      .limit(100);

    const nodes = rows.map((row) => ({
      id: row.nodeID,
      // agentd_nodes has no dedicated name column — fall back to
      // ip:port for display. If/when a friendly name is added to the
      // schema, prefer it here.
      label: `${row.ip}:${row.port}`,
      ip: row.ip,
      port: row.port,
      // Effective status — see file header for why we don't trust the
      // stored column. The Desktop UI uses this to grey out offline
      // options and to give feedback when the user picks a dead node.
      status: computeNodeStatus(row.status, row.lastHeartbeat),
      lastHeartbeat: row.lastHeartbeat?.toISOString() ?? null,
    }));

    return Response.json({ ok: true, nodes });
  } catch (error) {
    logger.error('list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { ok: false, error: 'Failed to list agentd nodes.' },
      { status: 500 },
    );
  }
});
