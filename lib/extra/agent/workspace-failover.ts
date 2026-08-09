/**
 * Workspace failover detector.
 *
 * When the node a workspace's long-lived container is bound to goes offline
 * for long enough that the container is presumed gone (offline > threshold),
 * we bump the workspace's node_generation and clear preferred_node_id so the
 * next task lazily re-creates the container on a healthy node. The bumped
 * generation is the fencing token: a stale agentd that still holds the old
 * container will, on its next acquire, see gen < workspaces.node_generation
 * and self-destruct its stale container (M1.3 wiring).
 *
 * Trigger:
 *  - Primary: piggyback on the agentd heartbeat path (mirrors reapStaleNodes
 *    and maybeSweepExpiredKv). No external scheduler required.
 *  - Fallback: a Vercel cron route for serverless deployments where the
 *    heartbeat path may not run regularly (no nodes = no heartbeats = no
 *    sweeper). See app/api/cron/workspace-failover/route.ts.
 *
 * Two in-process guards keep it cheap:
 *  - Time throttle: at most one sweep per FAILOVER_MIN_INTERVAL_MS per process.
 *  - In-flight guard: a concurrent heartbeat doesn't fan out a second sweep.
 * Like maybeSweepExpiredKv, this is best-effort — a few redundant sweeps across
 * instances are harmless because bumpGeneration + clearPreferredNode is
 * idempotent for a workspace that has already failed over.
 *
 * IMPORTANT: this module is imported from the heartbeat route and the cron
 * route (both Node runtime, never the workflow bundle), so it may use dynamic
 * imports normally; it deliberately avoids top-level node:* imports out of
 * caution since it sits under lib/.
 */
import { isSelfHosted } from '@/lib/extra/deploy';

/**
 * How long a workspace's preferred node must be offline before we fail it
 * over. Deliberately longer than NODE_HEARTBEAT_TIMEOUT_MS (2min) so brief
 * network blips don't trigger state-resetting failovers.
 */
export const FAILOVER_GRACE_MS = 5 * 60 * 1000;
export const FAILOVER_MIN_INTERVAL_MS = 60 * 1000;

let _lastFailoverAt = 0;
let _inFlight: Promise<number> | null = null;

/**
 * Detect workspaces whose preferred node has been offline past the grace
 * period and fail them over. Returns the number of workspaces migrated.
 * Skipped (returns 0) when self-hosted gate fails, the throttle window
 * hasn't elapsed, or a sweep is already in flight. Never throws — callers
 * on the heartbeat / cron path must not be broken by a failover failure.
 *
 * On Vercel (serverless), `isSelfHosted` is false so this no-ops; the cron
 * route calls {@link failoverOfflineWorkspaces} directly to cover that
 * deployment shape.
 */
export async function maybeFailoverWorkspaces(
  now: number = Date.now(),
): Promise<number> {
  if (!isSelfHosted) return 0;
  if (_inFlight) return 0;
  if (now - _lastFailoverAt < FAILOVER_MIN_INTERVAL_MS) return 0;

  _lastFailoverAt = now;
  _inFlight = (async () => {
    try {
      return await failoverOfflineWorkspaces();
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * One failover pass. Finds every workspace whose preferred_node_id points at
 * a node that has been offline past {@link FAILOVER_GRACE_MS}, bumps its
 * node_generation, clears preferred_node_id (so the next lazy create picks a
 * fresh node), and queues a workspace_failover notification. Idempotent — a
 * workspace that has already been failed over (preferred_node_id IS NULL)
 * won't be picked up again.
 *
 * Exported separately from {@link maybeFailoverWorkspaces} so the cron route
 * can run a pass on serverless deployments without the self-hosted gate or
 * the in-process throttle (cron is already globally rate-limited by schedule).
 */
export async function failoverOfflineWorkspaces(): Promise<number> {
  const { db } = await import('@/lib/core/db');
  const { workspaces, agentdNodes } = await import('@/lib/core/db/schema');
  const { and, eq, isNotNull, lt, isNull, sql } = await import('drizzle-orm');

  const cutoff = new Date(Date.now() - FAILOVER_GRACE_MS);

  // Join workspaces → their preferred node, filter to:
  //   - workspace is active
  //   - preferred_node_id is set (not already failed over)
  //   - the node's last heartbeat is past the grace cutoff (stale)
  //     OR the node row doesn't exist at all (unregistered / deleted zombie)
  const stale = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      name: workspaces.name,
      preferredNodeId: workspaces.preferredNodeId,
    })
    .from(workspaces)
    .leftJoin(agentdNodes, eq(workspaces.preferredNodeId, agentdNodes.nodeID))
    .where(
      and(
        eq(workspaces.status, 'active'),
        isNotNull(workspaces.preferredNodeId),
        sql`(${agentdNodes.nodeID} IS NULL OR ${agentdNodes.lastHeartbeat} < ${cutoff})`,
      ),
    );

  if (stale.length === 0) return 0;

  for (const ws of stale) {
    // Bump generation + clear preferred_node_id in one shot. The bumped
    // generation is what lets a stale agentd self-destruct its old container.
    await db
      .update(workspaces)
      .set({
        preferredNodeId: null,
        nodeGeneration: sql`${workspaces.nodeGeneration} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, ws.id));

    // Best-effort notification — never let a notification failure roll back
    // the failover. The owner may have no IM channel configured, in which
    // case createNotification still inserts a row for the Web inbox.
    try {
      const { createNotification } = await import('@/lib/core/db/notification');
      const { resolveWorkspaceDeliveryTarget } = await import(
        '@/lib/extra/agent/workspace-delivery'
      );
      const target = await resolveWorkspaceDeliveryTarget(ws.ownerId);
      if (target) {
        await createNotification({
          userId: ws.ownerId,
          taskId: null,
          notificationType: 'workspace_failover',
          payload: {
            type: 'workspace_failover',
            workspace_id: ws.id,
            workspace_name: ws.name,
            stale_node_id: ws.preferredNodeId,
            reason: 'node_offline',
          },
          channel: target.channel,
          targetChatId: target.targetChatId,
          targetUserId: target.targetUserId,
          severity: 'attention',
        });
      }
    } catch (notifyError) {
      // Logged via the route's logger context if available; swallow here.
      void notifyError;
    }
  }

  return stale.length;
}
