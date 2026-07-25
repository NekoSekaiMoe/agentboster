export const dynamic = 'force-dynamic';

import {
  reclaimNodeAddress,
  upsertAgentdNode,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';
import { NextRequest } from 'next/server';

const logger = createLogger('api.agentd.nodes.register');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { node_id, ip, port, sandboxes, version } = body;

    if (!node_id || !ip || !port || !sandboxes || !version) {
      return Response.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 },
      );
    }

    // Reclaim stale row by (ip, port) if the daemon restarted with a
    // fresh node_id. The by-node_id upsert itself is handled by
    // upsertAgentdNode below (Repository pattern — no direct db.* here).
    const reclaimed = await reclaimNodeAddress({
      ip,
      port,
      newNodeID: node_id,
    });
    if (reclaimed) {
      logger.info('reclaiming stale node row by (ip, port)', {
        old_node_id: reclaimed,
        new_node_id: node_id,
        ip,
        port,
      });
    }

    await upsertAgentdNode({
      nodeID: node_id,
      ip,
      port,
      sandboxes,
      version,
    });

    logger.info('node registered', { node_id, ip, port, version });

    return Response.json({
      success: true,
      node_id,
      interval: 30,
    });
  } catch (error) {
    logger.error('node register failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Registration failed' },
      { status: 500 },
    );
  }
}
