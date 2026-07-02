/**
 * GET /api/cli/nodes
 *
 * Lists Agent Daemon nodes the CLI can target via `/switch`.
 *
 * The CLI is a thin client: this endpoint deliberately returns only the
 * fields the CLI needs to render a node picker (id, label, status,
 * sandbox kinds, and a rough load indicator). It does NOT leak ip/port
 * or mTLS material — the CLI never talks to agentd directly; when a
 * session is switched to a remote node, tool calls are forwarded back
 * through `/api/cli/exec-on-agentd`, which holds the credentials.
 *
 * Only nodes with a heartbeat inside the last 2 minutes and status
 * 'online' are returned; the CLI should not offer stale nodes.
 */

import { withCliAuth } from '@/lib/cli/auth';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { and, eq, gte } from 'drizzle-orm';

export const GET = withCliAuth(async () => {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const rows = await db
    .select({
      nodeId: agentdNodes.nodeID,
      sandboxes: agentdNodes.sandboxes,
      cpuUsage: agentdNodes.cpuUsage,
      activeTasks: agentdNodes.activeTasks,
    })
    .from(agentdNodes)
    .where(
      and(
        eq(agentdNodes.status, 'online'),
        gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
      ),
    );

  // agentdNodes has no human-readable label column; the CLI surfaces the
  // nodeId as the picker label. Host ip/port are intentionally withheld —
  // the CLI never connects to agentd directly (see file header).
  const nodes = rows.map((n) => ({
    nodeId: n.nodeId,
    sandboxes: n.sandboxes ?? [],
    load: n.cpuUsage != null ? Math.round(n.cpuUsage) : null,
    activeTasks: n.activeTasks ?? 0,
  }));

  return Response.json({ ok: true, nodes });
});
