import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      node_id,
      cpu_usage,
      mem_avail,
      disk_avail,
      active_tasks,
      active_sandboxes,
      timestamp,
    } = body;

    if (!node_id) {
      return NextResponse.json(
        { error: 'node_id is required' },
        { status: 400 },
      );
    }

    const existing = await db.query.agentdNodes.findFirst({
      where: eq(agentdNodes.nodeID, node_id),
    });

    if (!existing) {
      return NextResponse.json({ error: 'node not found' }, { status: 404 });
    }

    await db
      .update(agentdNodes)
      .set({
        cpuUsage: cpu_usage != null ? Math.round(cpu_usage * 100) : undefined,
        memAvail: mem_avail != null ? Math.round(mem_avail * 100) : undefined,
        diskAvail:
          disk_avail != null ? Math.round(disk_avail * 100) : undefined,
        activeTasks: active_tasks ?? existing.activeTasks,
        activeSandboxes: active_sandboxes ?? existing.activeSandboxes,
        status: 'online',
        lastHeartbeat: timestamp ? new Date(timestamp * 1000) : new Date(),
      })
      .where(eq(agentdNodes.nodeID, node_id));

    return NextResponse.json({ accepted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
