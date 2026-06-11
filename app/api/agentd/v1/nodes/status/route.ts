import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { desc } from 'drizzle-orm';

const logger = createLogger('api.agentd.nodes.status');

export async function GET() {
  try {
    const rows = await db
      .select()
      .from(agentdNodes)
      .orderBy(desc(agentdNodes.lastHeartbeat))
      .limit(100);

    const nodes = rows.map((row) => ({
      node_id: row.nodeID,
      ip: row.ip,
      port: row.port,
      sandboxes: row.sandboxes,
      version: row.version,
      status: row.status,
      cpu_model: row.cpuModel,
      cpu_usage: row.cpuUsage,
      mem_avail: row.memAvail,
      disk_avail: row.diskAvail,
      active_tasks: row.activeTasks,
      active_sandboxes: row.activeSandboxes,
      last_heartbeat: row.lastHeartbeat?.toISOString() ?? null,
      registered_at: row.registeredAt?.toISOString() ?? null,
    }));

    return Response.json({ nodes });
  } catch (error) {
    logger.error('status fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to fetch nodes' },
      { status: 500 },
    );
  }
}
