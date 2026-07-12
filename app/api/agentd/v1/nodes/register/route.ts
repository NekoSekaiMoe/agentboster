export const dynamic = 'force-dynamic';

import { findNodeByAddress } from '@/lib/extra/agent/node-liveness';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
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

    // Dedup by node_id first (the normal case — agentd persisted its
    // ID across a process restart).
    const existingById = await db
      .select()
      .from(agentdNodes)
      .where(eq(agentdNodes.nodeID, node_id))
      .limit(1);

    let existingNodeId: string | null = existingById[0]?.nodeID ?? null;

    // Fallback dedup by (ip, port): if the daemon restarted with a
    // fresh node_id (e.g. host reboot wiped the persisted node_id file),
    // reclaim the stale row for the same address instead of inserting a
    // duplicate. We update its node_id to the new value so subsequent
    // heartbeats land on it.
    if (!existingNodeId) {
      const byAddress = await findNodeByAddress(ip, port);
      if (byAddress) {
        logger.info('reclaiming stale node row by (ip, port)', {
          old_node_id: byAddress.nodeID,
          new_node_id: node_id,
          ip,
          port,
        });
        await db
          .update(agentdNodes)
          .set({ nodeID: node_id })
          .where(eq(agentdNodes.nodeID, byAddress.nodeID));
        existingNodeId = node_id;
      }
    }

    if (existingNodeId) {
      await db
        .update(agentdNodes)
        .set({
          ip,
          port,
          sandboxes,
          version,
          status: 'online',
          lastHeartbeat: new Date(),
        })
        .where(eq(agentdNodes.nodeID, node_id));
    } else {
      await db.insert(agentdNodes).values({
        nodeID: node_id,
        ip,
        port,
        sandboxes,
        version,
        status: 'online',
        lastHeartbeat: new Date(),
      });
    }

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
