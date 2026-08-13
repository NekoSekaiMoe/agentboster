/**
 * PGlite integration tests for the run-level task lease system
 * (lib/core/agent/task-lease.ts). Verifies the two safety properties:
 *
 *  1. renewTaskLeases(nodeId) only extends leases for tasks that node OWNS,
 *     leaving other nodes' tasks and terminal tasks untouched.
 *  2. reapOrphanedTasks() only reclaims in-flight tasks whose lease expired
 *     AND whose owner node is heartbeat-stale. A live owner (recent
 *     heartbeat) is never reaped even if its lease is past; a pending task
 *     with no owner (L2 review wait) is never reaped.
 *
 * Mocks @/lib/core/db to inject the PGlite drizzle client, same pattern as
 * agentd.workspaces.test.ts. The DDL mirrors only the columns the lease
 * queries touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

const DDL = [
  `CREATE TABLE "agent_tasks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "owner_node_id" text,
    "lease_expires_at" timestamptz,
    "failure_reason" text,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agentd_nodes" (
    "node_id" text PRIMARY KEY NOT NULL,
    "status" text DEFAULT 'offline' NOT NULL,
    "last_heartbeat" timestamptz,
    "registered_at" timestamptz DEFAULT now() NOT NULL
  )`,
];

const harness = setupPgLiteTestDb(DDL);

vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
}));

import {
  renewTaskLeases,
  reapOrphanedTasks,
} from '@/lib/core/agent/task-lease';
import { TASK_LEASE_SECONDS } from '@/lib/core/agent/task-lease-constants';

/** Seed a node row. heartbeatAgeMs controls last_heartbeat freshness
 *  (0 = now = online-fresh; large = stale). */
async function seedNode(
  nodeId: string,
  opts: { heartbeatAgeMs?: number; status?: string } = {},
): Promise<void> {
  const age = opts.heartbeatAgeMs ?? 0;
  const hb =
    age === 0
      ? sql`now()`
      : sql`now() - (${age}::text || ' milliseconds')::interval`;
  await harness.db.execute(
    sql`INSERT INTO "agentd_nodes" ("node_id", "status", "last_heartbeat")
        VALUES (${nodeId}, ${opts.status ?? 'online'}, ${hb})`,
  );
}

/** Seed a task row. Returns its id. */
async function seedTask(opts: {
  status?: string;
  ownerNodeId?: string | null;
  /** Lease offset from now, in ms. Negative = already expired. */
  leaseOffsetMs?: number | null;
}): Promise<string> {
  const lease =
    opts.leaseOffsetMs === undefined || opts.leaseOffsetMs === null
      ? null
      : opts.leaseOffsetMs >= 0
        ? sql`now() + (${opts.leaseOffsetMs}::text || ' milliseconds')::interval`
        : sql`now() - (${-opts.leaseOffsetMs}::text || ' milliseconds')::interval`;
  const [row] = (
    await harness.db.execute(
      sql`INSERT INTO "agent_tasks" ("status", "owner_node_id", "lease_expires_at")
          VALUES (${opts.status ?? 'running'}, ${opts.ownerNodeId ?? null}, ${lease})
          RETURNING "id"`,
    )
  ).rows as { id: string }[];
  return row.id;
}

async function getTask(id: string): Promise<{
  status: string;
  failureReason: string | null;
  leaseExpiresAt: Date | null;
}> {
  const rows = (
    await harness.db.execute(
      sql`SELECT "status", "failure_reason", "lease_expires_at" FROM "agent_tasks" WHERE "id" = ${id}::uuid`,
    )
  ).rows as {
    status: string;
    failure_reason: string | null;
    lease_expires_at: string | Date | null;
  }[];
  if (!rows[0])
    return { status: '?', failureReason: null, leaseExpiresAt: null };
  const raw = rows[0].lease_expires_at;
  return {
    status: rows[0].status,
    failureReason: rows[0].failure_reason,
    leaseExpiresAt: raw ? new Date(raw) : null,
  };
}

describe('task-lease (PGlite)', () => {
  beforeEach(async () => {
    await resetDb(harness.db, ['agent_tasks', 'agentd_nodes']);
  });

  describe('renewTaskLeases', () => {
    it('extends leases only for in-flight tasks owned by the node', async () => {
      await seedNode('node-a');
      const mine = await seedTask({
        ownerNodeId: 'node-a',
        leaseOffsetMs: 5000,
      });
      const otherNodeTask = await seedTask({
        ownerNodeId: 'node-b',
        leaseOffsetMs: 5000,
      });
      const myTerminalTask = await seedTask({
        status: 'completed',
        ownerNodeId: 'node-a',
        leaseOffsetMs: 5000,
      });

      const renewed = await renewTaskLeases('node-a');

      expect(renewed).toBe(1); // only `mine`, not the completed one
      const mineRow = await getTask(mine);
      const otherRow = await getTask(otherNodeTask);
      const terminalRow = await getTask(myTerminalTask);
      // Renewed to ~now + LEASE_SECONDS (allow small clock slop).
      expect(mineRow.leaseExpiresAt).not.toBeNull();
      const mineExpiry = mineRow.leaseExpiresAt;
      expect(mineExpiry).not.toBeNull();
      const remainingMs =
        mineExpiry !== null
          ? (mineExpiry.getTime() - Date.now()) / 1000
          : -Infinity;
      expect(remainingMs).toBeGreaterThan(TASK_LEASE_SECONDS - 5);
      expect(remainingMs).toBeLessThan(TASK_LEASE_SECONDS + 5);
      // Other node's task untouched.
      const otherRemainingMs = otherRow.leaseExpiresAt
        ? (otherRow.leaseExpiresAt.getTime() - Date.now()) / 1000
        : null;
      expect(otherRemainingMs).toBeLessThan(10); // still ~5s, not renewed
      // Terminal task untouched (renew excludes terminal statuses).
      expect(terminalRow.leaseExpiresAt?.getTime()).toBeLessThan(
        Date.now() + 10000,
      );
    });
  });

  describe('reapOrphanedTasks', () => {
    it('reclaims an in-flight task whose lease expired AND owner is offline', async () => {
      // Owner node heartbeat is 5 minutes stale (well past the 2-min cutoff).
      await seedNode('dead-node', { heartbeatAgeMs: 5 * 60 * 1000 });
      const taskId = await seedTask({
        ownerNodeId: 'dead-node',
        leaseOffsetMs: -120_000, // lease expired 2 min ago
      });

      const { reclaimed } = await reapOrphanedTasks();

      expect(reclaimed).toBe(1);
      const row = await getTask(taskId);
      expect(row.status).toBe('failed');
      expect(row.failureReason).toBe('owner_node_offline_lease_expired');
    });

    it('does NOT reclaim when the owner is still heartbeat-fresh (live node, slow lease)', async () => {
      // Owner heartbeat is fresh (30s ago, within the 2-min window) even
      // though the task's lease has expired — this is the "slow-but-alive
      // node under DB latency" case the two-condition gate protects.
      await seedNode('live-node', { heartbeatAgeMs: 30_000 });
      const taskId = await seedTask({
        ownerNodeId: 'live-node',
        leaseOffsetMs: -120_000,
      });

      const { reclaimed } = await reapOrphanedTasks();

      expect(reclaimed).toBe(0);
      const row = await getTask(taskId);
      expect(row.status).toBe('running'); // untouched
    });

    it('does NOT reclaim a pending task with no owner (L2 review wait)', async () => {
      // No owner_node_id — this is the "queued pending L2 review" state.
      // Even with an ancient lease it must survive (no node to have died).
      const taskId = await seedTask({
        status: 'pending',
        ownerNodeId: null,
        leaseOffsetMs: null,
      });

      const { reclaimed } = await reapOrphanedTasks();

      expect(reclaimed).toBe(0);
      const row = await getTask(taskId);
      expect(row.status).toBe('pending');
    });

    it('does NOT reclaim a terminal task even if lease/owner look stale', async () => {
      await seedNode('dead-node', { heartbeatAgeMs: 5 * 60 * 1000 });
      const taskId = await seedTask({
        status: 'completed',
        ownerNodeId: 'dead-node',
        leaseOffsetMs: -120_000,
      });

      const { reclaimed } = await reapOrphanedTasks();

      expect(reclaimed).toBe(0);
      const row = await getTask(taskId);
      expect(row.status).toBe('completed');
    });

    it('reclaims multiple orphaned tasks across different dead nodes in one sweep', async () => {
      await seedNode('dead-1', { heartbeatAgeMs: 5 * 60 * 1000 });
      await seedNode('dead-2', { heartbeatAgeMs: 10 * 60 * 1000 });
      await seedNode('live-1', { heartbeatAgeMs: 10_000 });
      await seedTask({
        ownerNodeId: 'dead-1',
        leaseOffsetMs: -120_000,
      });
      await seedTask({
        ownerNodeId: 'dead-2',
        leaseOffsetMs: -300_000,
      });
      const liveTask = await seedTask({
        ownerNodeId: 'live-1',
        leaseOffsetMs: -120_000, // lease expired but owner alive → kept
      });

      const { reclaimed } = await reapOrphanedTasks();

      expect(reclaimed).toBe(2); // dead-1 + dead-2, not live-1
      const live = await getTask(liveTask);
      expect(live.status).toBe('running'); // live owner's task survives
    });
  });
});
