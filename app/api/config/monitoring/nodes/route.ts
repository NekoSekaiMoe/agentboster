import { computeNodeStatus } from '@/lib/extra/agent/node-liveness';
import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { desc } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const cookieStore = await cookies();
    try {
      await requireAuthAccess(cookieStore);
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 401;
      return NextResponse.json({ error: 'Unauthorized' }, { status });
    }
    const rows = await db
      .select({
        id: agentdNodes.nodeID,
        hostname: agentdNodes.ip,
        status: agentdNodes.status,
        lastHeartbeat: agentdNodes.lastHeartbeat,
        cpuUsage: agentdNodes.cpuUsage,
        memoryUsage: agentdNodes.memAvail,
        diskUsage: agentdNodes.diskAvail,
      })
      .from(agentdNodes)
      .orderBy(desc(agentdNodes.lastHeartbeat))
      .limit(100);

    // Effective status is computed from heartbeat freshness — the stored
    // column is only ever 'online', so a dead node would otherwise stay
    // green in the monitoring UI.
    const nodes = rows.map((row) => ({
      ...row,
      status: computeNodeStatus(row.status, row.lastHeartbeat),
    }));

    return NextResponse.json(nodes);
  } catch (error) {
    console.error('Failed to fetch nodes:', error);
    return NextResponse.json(
      { error: 'Failed to fetch nodes' },
      { status: 500 },
    );
  }
}
