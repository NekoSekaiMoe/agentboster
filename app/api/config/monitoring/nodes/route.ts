import { readAuthSessionFromCookies } from '@/lib/auth';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { desc } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const nodes = await db
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

    return NextResponse.json(nodes);
  } catch (error) {
    console.error('Failed to fetch nodes:', error);
    return NextResponse.json(
      { error: 'Failed to fetch nodes' },
      { status: 500 },
    );
  }
}
