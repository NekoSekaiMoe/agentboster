import { inArray } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { computeNodeStatus } from '@/lib/extra/agent/node-liveness';

/**
 * Workspace container-status derivation, shared by the workspaces list
 * and detail APIs.
 *
 * agentd exposes no container-status endpoint (the run lock lives in
 * agentd memory with no read path), so the deepest honest answer we can
 * give is derived from the workspace's node binding + the node's
 * heartbeat-computed health:
 *   - no preferred node      → 'not_created' (container is lazily created
 *                              on the first task)
 *   - node offline / missing → 'unreachable'
 *   - node online            → 'unknown' (bound, but actual container
 *                              liveness is not queryable)
 */
export type DerivedContainerStatus = 'not_created' | 'unreachable' | 'unknown';

export function deriveContainerStatus(
  preferredNodeId: string | null,
  nodeStatus: 'online' | 'offline' | null,
): DerivedContainerStatus {
  if (!preferredNodeId) return 'not_created';
  if (nodeStatus !== 'online') return 'unreachable';
  return 'unknown';
}

/**
 * Batch-load the effective status of many agentd nodes in ONE query
 * (inArray — no N+1). Node ids missing from the result set (zombie-reaped
 * or re-registered rows) are simply absent from the map; callers treat an
 * absent id as 'offline', mirroring the detail route's vanished-node path.
 *
 * Uses computeNodeStatus — never the raw agentd_nodes.status column, which
 * is advisory (nothing reliably flips it offline).
 */
export async function getWorkspaceNodeStatuses(
  nodeIds: readonly string[],
): Promise<Map<string, 'online' | 'offline'>> {
  const unique = [...new Set(nodeIds.filter(Boolean))];
  const map = new Map<string, 'online' | 'offline'>();
  if (unique.length === 0) return map;
  const rows = await db
    .select({
      nodeID: agentdNodes.nodeID,
      status: agentdNodes.status,
      lastHeartbeat: agentdNodes.lastHeartbeat,
    })
    .from(agentdNodes)
    .where(inArray(agentdNodes.nodeID, unique));
  for (const row of rows) {
    map.set(row.nodeID, computeNodeStatus(row.status, row.lastHeartbeat));
  }
  return map;
}
