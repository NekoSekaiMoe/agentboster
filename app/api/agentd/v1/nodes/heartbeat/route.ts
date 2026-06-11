import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const logger = createLogger('api.agentd.nodes.heartbeat');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      node_id,
      cpu_model,
      cpu_usage,
      mem_avail,
      disk_avail,
      active_tasks,
      active_sandboxes,
    } = body;

    if (!node_id) {
      return Response.json(
        { success: false, error: 'Missing node_id' },
        { status: 400 },
      );
    }

    await db
      .update(agentdNodes)
      .set({
        cpuModel: cpu_model,
        cpuUsage: cpu_usage != null ? Math.round(cpu_usage * 100) : null,
        memAvail: mem_avail != null ? Math.round(mem_avail * 100) : null,
        diskAvail: disk_avail != null ? Math.round(disk_avail * 100) : null,
        activeTasks: active_tasks ?? 0,
        activeSandboxes: active_sandboxes ?? 0,
        lastHeartbeat: new Date(),
        status: 'online',
      })
      .where(eq(agentdNodes.nodeID, node_id));

    return Response.json({
      success: true,
      accepted: true,
    });
  } catch (error) {
    logger.error('heartbeat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Heartbeat failed' },
      { status: 500 },
    );
  }
}
