import { NextResponse } from 'next/server';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { node_id, ip, port, sandboxes, version } = body;

    if (!node_id || !ip || !port) {
      return NextResponse.json(
        { error: 'node_id, ip, and port are required' },
        { status: 400 },
      );
    }

    const existing = await db.query.agentdNodes.findFirst({
      where: eq(agentdNodes.nodeID, node_id),
    });

    if (existing) {
      await db
        .update(agentdNodes)
        .set({
          ip,
          port,
          sandboxes: sandboxes || existing.sandboxes,
          version: version || existing.version,
          status: 'online',
          lastHeartbeat: new Date(),
        })
        .where(eq(agentdNodes.nodeID, node_id));
    } else {
      await db.insert(agentdNodes).values({
        nodeID: node_id,
        ip,
        port: Number(port),
        sandboxes: sandboxes || [],
        version: version || 'unknown',
        status: 'online',
        lastHeartbeat: new Date(),
      });
    }

    return NextResponse.json({
      node_id,
      interval: 30,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
