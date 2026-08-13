/**
 * Run-level leases for agent_tasks: the Web-tier authoritative lease that
 * lets a multi-node agentd deployment reclaim tasks whose owning node
 * crashed or partitioned. The daemon stays stateless and crash-recoverable
 * (no on-disk lease store) — it merely RENEWS via heartbeat. All CAS
 * UPDATEs live here and run in the Postgres table the Web tier owns.
 *
 * Lifecycle (mirrors deer-flow's runs ownership, adapted to agentboster's
 * node-heartbeat cadence — see docs/design/soft-quarantine-memory-on-
 * privatization.md §B for the full design reference):
 *
 *   GRANT   createTask({ ownerNodeId }) sets lease_expires_at = now + LEASE.
 *           A task created without an owner (pending review) stays NULL
 *           until a node claims it at the pending → reviewing/running flip.
 *   RENEW   renewTaskLeases(nodeId) runs on every heartbeat (agentd pings
 *           every 30s). Conditional UPDATE: only rows where
 *           owner_node_id = nodeId AND status in-flight.
 *   RECLAIM reapOrphanedTasks(graceSeconds) flips in-flight rows whose
 *           lease is older than now - grace AND whose owner node is
 *           currently offline (not just lease-expired — the node must
 *           ALSO be heartbeat-stale, so a slow-but-alive node is not
 *           mis-reclaimed). Piggybacks on the heartbeat route like the
 *           node reaper.
 *   GUARD   updateTaskStatus owner-guard rejects mutations from a node
 *           that does not own the row, so a stale daemon returning after
 *           reclaim cannot clobber the recovery another node performed.
 *
 * `TASK_LEASE_GRACE_SECONDS` is the clock-skew budget across nodes' UTC
 * clocks (same role as deer-flow's grace_seconds): reclaim compares
 * lease_expires_at to the DB's now(), and grace must be >= the heartbeat
 * interval slop (30s heartbeat, 90s lease, 60s grace ⇒ a node misses ~2
 * heartbeats + skew before reclaim).
 *
 * See AGENTS.md "agentd_nodes.status is advisory" rule: this module never
 * trusts the status column alone — it joins against heartbeat freshness
 * via NODE_HEARTBEAT_TIMEOUT_MS, the same primitive selectBestNode uses.
 */
import { db } from '@/lib/core/db';
import { agentTasks, agentdNodes } from '@/lib/core/db/schema';
import { NODE_HEARTBEAT_TIMEOUT_MS } from '@/lib/extra/agent/node-liveness';
import { createLogger } from '@/lib/utils/logger';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  TASK_LEASE_SECONDS,
  TASK_LEASE_GRACE_SECONDS,
} from './task-lease-constants';

const logger = createLogger('agent.task-lease');

// Re-export the timing constants (defined in task-lease-constants.ts to
// avoid a circular import with lib/core/db/agentd.ts) so callers can import
// everything lease-related from this module.
export { TASK_LEASE_SECONDS, TASK_LEASE_GRACE_SECONDS };

/** Statuses considered "in-flight" for lease/reclaim purposes. */
const IN_FLIGHT_STATUSES = ['pending', 'reviewing', 'running'] as const;

/**
 * Renew every in-flight task owned by `nodeId` to now + TASK_LEASE_SECONDS.
 * Called from the heartbeat route. Conditional on owner + status so a node
 * cannot renew tasks it does not own (defense in depth — the heartbeat
 * already proves node identity via mTLS, but a bug that passed the wrong
 * node_id would still be fenced here).
 *
 * Returns the count of renewed rows for observability. Best-effort: the
 * caller (heartbeat route) wraps this in try/catch and never fails the
 * heartbeat on a renewal error.
 */
export async function renewTaskLeases(
  nodeId: string,
  now: Date = new Date(),
): Promise<number> {
  const newExpiresAt = new Date(now.getTime() + TASK_LEASE_SECONDS * 1000);
  const rows = await db
    .update(agentTasks)
    .set({ leaseExpiresAt: newExpiresAt, updatedAt: now })
    .where(
      and(
        eq(agentTasks.ownerNodeId, nodeId),
        inArray(agentTasks.status, [...IN_FLIGHT_STATUSES]),
      ),
    )
    .returning({ id: agentTasks.id });
  return rows.length;
}

/**
 * Reclaim in-flight tasks whose lease has expired AND whose owner node is
 * currently offline (heartbeat stale past NODE_HEARTBEAT_TIMEOUT_MS). The
 * two-condition gate is the key safety property: a slow-but-alive node
 * whose DB writes are merely delayed (lease expired) but whose heartbeats
 * are still fresh is NOT reclaimed — only a genuinely-dead node's tasks
 * are marked failed. This avoids the "mis-reclaim a live node under DB
 * latency spike" failure mode that a lease-only check would have.
 *
 * Reclaimed tasks flip to status='failed' with a structured failure_reason
 * so the existing retry path (attempt < maxAttempts → spawn retry child)
 * can re-drive them onto a healthy node. Returns counts for observability.
 *
 * Piggybacks on the heartbeat route (every 30s) like reapStaleNodes — no
 * external scheduler. Safe to call concurrently: the conditional UPDATE
 * is idempotent over the stable expired+offline row set.
 */
export async function reapOrphanedTasks(
  now: Date = new Date(),
  graceSeconds: number = TASK_LEASE_GRACE_SECONDS,
): Promise<{ reclaimed: number }> {
  const leaseCutoff = new Date(now.getTime() - graceSeconds * 1000);
  const heartbeatCutoff = new Date(now.getTime() - NODE_HEARTBEAT_TIMEOUT_MS);

  // Inline the heartbeat-freshness subquery against agentd_nodes rather
  // than calling computeNodeStatus (which is per-row JS): this is a bulk
  // UPDATE that needs a single SQL predicate. A node is "offline" here
  // when it has NO row with status='online' AND last_heartbeat >= the
  // heartbeat cutoff — i.e. it is not in the set of currently-live nodes.
  // This mirrors selectBestNode's freshness filter and the reaper's
  // markedOffline predicate.
  const rows = await db
    .update(agentTasks)
    .set({
      status: 'failed',
      failureReason: 'owner_node_offline_lease_expired',
      // Clear the expired lease so the row matches the terminal-state
      // shape used by updateTaskStatus (completed/failed/cancelled all
      // null out lease_expires_at). Without this the failed row keeps a
      // stale expiry timestamp that can confuse liveness probes / UI.
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(agentTasks.status, [...IN_FLIGHT_STATUSES]),
        // Lease expired. We only reclaim rows that HAVE an owner (non-NULL
        // owner_node_id) — pending-review tasks waiting on L2 approval
        // have no owner yet and must not be reaped. This keeps the reclaim
        // path focused on the real orphan gap (a claimed task whose node
        // died) without endangering the human-in-the-loop wait state.
        // Legacy rows pre-dating leases also have NULL owner and are left
        // alone (they pre-date multi-node and are single-node-assumed).
        isNotNull(agentTasks.ownerNodeId),
        lte(agentTasks.leaseExpiresAt, leaseCutoff),
        // Owner node is offline: NOT EXISTS a live node row for this owner.
        sql`NOT EXISTS (
          SELECT 1 FROM ${agentdNodes}
          WHERE ${agentdNodes.nodeID} = ${agentTasks.ownerNodeId}
            AND ${agentdNodes.status} = 'online'
            AND ${agentdNodes.lastHeartbeat} >= ${heartbeatCutoff}
        )`,
      ),
    )
    .returning({ id: agentTasks.id });
  const reclaimed = rows.length;
  if (reclaimed > 0) {
    logger.info('reaped orphaned agent_tasks', { reclaimed });
  }
  return { reclaimed };
}
