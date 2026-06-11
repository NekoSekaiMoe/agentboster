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

    const existing = await db
      .select()
      .from(agentdNodes)
      .where(eq(agentdNodes.nodeID, node_id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentdNodes)
        .set({
          ip,
          port,
          sandboxes,
          version,
          status: 'online',
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
