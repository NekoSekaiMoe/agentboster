import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { and, eq, lt } from 'drizzle-orm';

/**
 * Heartbeat staleness window. A node is considered online only if its
 * last heartbeat is within this window. Matches the dispatch path's
 * rule (lib/workflow/agent/dispatch.ts) and the CLI nodes route.
 *
 * agentd's default heartbeat interval is 30s, so 2 minutes = ~4 missed
 * heartbeats before a node is marked offline.
 */
export const NODE_HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Hard cutoff for zombie node reaping. Rows whose last heartbeat is
 * older than this are deleted outright by reapStaleNodes(), since they
 * will never come back (a re-register with a fresh node_id always
 * creates a new row — see register route's (ip,port) dedup).
 */
export const NODE_ZOMBIE_CUTOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Threshold (as a Date) below which a node is considered offline.
 * Pass to drizzle's `gte(agentdNodes.lastHeartbeat, threshold)` or
 * use isNodeHeartbeatFresh().
 */
export function heartbeatOnlineThreshold(now: Date = new Date()): Date {
  return new Date(now.getTime() - NODE_HEARTBEAT_TIMEOUT_MS);
}

/**
 * Whether a row's lastHeartbeat is fresh enough to be considered online.
 * Null heartbeat (legacy/never-beat rows) is treated as offline.
 */
export function isNodeHeartbeatFresh(
  lastHeartbeat: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastHeartbeat) return false;
  const ts =
    typeof lastHeartbeat === 'string'
      ? Date.parse(lastHeartbeat)
      : lastHeartbeat.getTime();
  if (Number.isNaN(ts)) return false;
  return ts >= now.getTime() - NODE_HEARTBEAT_TIMEOUT_MS;
}

/**
 * Compute the effective status of a node row from its stored status
 * AND its heartbeat freshness. The stored `status` column is only ever
 * written to `'online'` (by register and heartbeat handlers), so the
 * freshness check is what actually drives liveness — this matches the
 * dispatch path's behavior (selectBestNode filters on both).
 *
 * Returns `'online'` only when the stored status is `'online'` AND the
 * heartbeat is within the staleness window; otherwise `'offline'`.
 */
export function computeNodeStatus(
  storedStatus: string | null,
  lastHeartbeat: Date | string | null | undefined,
  now: Date = new Date(),
): 'online' | 'offline' {
  if (storedStatus !== 'online') return 'offline';
  return isNodeHeartbeatFresh(lastHeartbeat, now) ? 'online' : 'offline';
}

/**
 * Sweep agentd_nodes:
 *  1. Flip stale-but-recent rows (heartbeat older than the online
 *     threshold but newer than the zombie cutoff) to status='offline'.
 *  2. Delete zombie rows (heartbeat older than the zombie cutoff, or
 *     status='offline' AND heartbeat older than the online threshold).
 *
 * This runs inline on the heartbeat path — every 30s an agentd node
 * pings the Web, and the reaper piggybacks on that. No external
 * scheduler or Vercel cron is required. Safe to call concurrently
 * (idempotent UPDATE/DELETE on a stable row set).
 *
 * Returns counts for observability.
 */
export async function reapStaleNodes(
  now: Date = new Date(),
): Promise<{ markedOffline: number; deletedZombies: number }> {
  const onlineThreshold = heartbeatOnlineThreshold(now);
  const zombieCutoff = new Date(now.getTime() - NODE_ZOMBIE_CUTOFF_MS);

  const markedOfflineResult = await db
    .update(agentdNodes)
    .set({ status: 'offline' })
    .where(
      and(
        eq(agentdNodes.status, 'online'),
        lt(agentdNodes.lastHeartbeat, onlineThreshold),
      ),
    );

  // Zombies: rows with no heartbeat in the last 24h. These will never
  // be reclaimed — register dedup reuses the row by (ip,port), so a
  // genuinely-restarted node already has a live row.
  const deletedZombiesResult = await db
    .delete(agentdNodes)
    .where(and(lt(agentdNodes.lastHeartbeat, zombieCutoff)));

  return {
    markedOffline: markedOfflineResult?.rowCount ?? 0,
    deletedZombies: deletedZombiesResult?.rowCount ?? 0,
  };
}

/**
 * Find an existing node row by (ip, port). Used by the register route
 * to reclaim a stale row when an agentd restarts with a fresh node_id
 * (e.g. after host reboot wiped /var/run/agentd.node_id).
 *
 * Returns the most recent matching row by registeredAt, or null.
 */
export async function findNodeByAddress(
  ip: string,
  port: number,
): Promise<{ nodeID: string } | null> {
  const rows = await db
    .select({ nodeID: agentdNodes.nodeID })
    .from(agentdNodes)
    .where(and(eq(agentdNodes.ip, ip), eq(agentdNodes.port, port)))
    .orderBy(agentdNodes.registeredAt)
    .limit(1);

  return rows[0]?.nodeID ? { nodeID: rows[0].nodeID } : null;
}
