import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    const nodes = await db.select().from(agentdNodes);

    const result = nodes.map((n: (typeof nodes)[0]) => ({
      node_id: n.nodeID,
      ip: n.ip,
      port: n.port,
      sandboxes: n.sandboxes,
      version: n.version,
      status:
        n.status === 'online' &&
        n.lastHeartbeat &&
        n.lastHeartbeat > twoMinutesAgo
          ? 'online'
          : 'offline',
      cpu_usage: n.cpuUsage != null ? n.cpuUsage / 100 : null,
      mem_avail: n.memAvail != null ? n.memAvail / 100 : null,
      disk_avail: n.diskAvail != null ? n.diskAvail / 100 : null,
      active_tasks: n.activeTasks,
      active_sandboxes: n.activeSandboxes,
      last_heartbeat: n.lastHeartbeat?.toISOString() || null,
      registered_at: n.registeredAt?.toISOString() || null,
    }));

    return NextResponse.json({ nodes: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
