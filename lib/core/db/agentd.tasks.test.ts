/**
 * updateTaskStatus tests against a REAL in-memory Postgres (PGlite) —
 * same strategy as agentd.workspaces.test.ts.
 *
 * What this catches that a hand-rolled drizzle mock cannot:
 *   - The snake_case set-key regression: `updates.owner_node_id` /
 *     `updates.lease_expires_at` are SILENTLY DROPPED by drizzle's
 *     buildUpdateSet (it only iterates the table's TS property names),
 *     so only a real SQL round-trip proves owner/lease columns move.
 *   - The claim-semantics WHERE (`owner_node_id = X OR owner_node_id
 *     IS NULL`): a stubbed WHERE never evaluates, so only real SQL
 *     proves an unowned task is claimable and a foreign-owned one 409s.
 *
 * Run via: yarn test lib/core/db/agentd.tasks.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

// Mirrors lib/core/db/schema/agentd.ts `agentTasks`. RETURNING (no args)
// in updateTaskStatus reads back every schema column, so the DDL must
// carry all of them. If the schema drifts from this DDL, the queries
// below fail, which is the intended signal.
const DDL = [
  `CREATE TABLE "agent_tasks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "agent_id" text NOT NULL,
    "session_id" uuid,
    "user_id" text,
    "workspace_id" uuid,
    "command" text NOT NULL,
    "sandbox_type" text DEFAULT 'auto' NOT NULL,
    "sandbox_id" text,
    "source" jsonb,
    "env" jsonb,
    "timeout" integer DEFAULT 300,
    "status" text DEFAULT 'pending' NOT NULL,
    "result" text,
    "failure_reason" text,
    "attempt" integer DEFAULT 1 NOT NULL,
    "max_attempts" integer DEFAULT 2 NOT NULL,
    "retry_of_task_id" uuid,
    "rerun_of_task_id" uuid,
    "owner_node_id" text,
    "lease_expires_at" timestamptz,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
];

const harness = setupPgLiteTestDb(DDL);

// Same mock shape as agentd.workspaces.test.ts: inject the PGlite drizzle
// client as `db` and pin the pg-transaction branch. `schema` is NOT
// re-exported here because agentd.ts imports its tables from './schema'
// directly (pure definitions, no connection side effects).
vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
  resolveDriver: () => 'postgres' as const,
}));

// updateTaskStatus never touches the KV version bump, but agentd.ts
// module-loads the shared-version module; stub it so no KV client is
// constructed under PGlite.
vi.mock('@/lib/memory/shared-version', () => ({
  bumpSharedMemoryVersion: vi.fn(),
}));

import { TASK_LEASE_SECONDS } from '@/lib/core/agent/task-lease-constants';
import { updateTaskStatus } from './agentd';

/** Seed a task row. owner/lease default to NULL (the pre-claim,
 *  pending-review shape); pass overrides for an owned in-flight task. */
async function seedTask(opts?: {
  status?: string;
  ownerNodeId?: string | null;
  withLease?: boolean;
}): Promise<string> {
  const status = opts?.status ?? 'pending';
  const owner = opts?.ownerNodeId ?? null;
  const lease = opts?.withLease
    ? new Date(Date.now() + 60_000).toISOString()
    : null;
  const [row] = (
    await harness.db.execute(
      sql`INSERT INTO "agent_tasks" ("agent_id", "user_id", "command", "status", "owner_node_id", "lease_expires_at")
          VALUES ('default', 'u1', 'echo hi', ${status}, ${owner}, ${lease})
          RETURNING "id"`,
    )
  ).rows as { id: string }[];
  return row.id;
}

/** Read the raw owner/lease/status columns straight from the DB — this is
 *  the ground truth that exposes the snake_case silent-drop regression
 *  (the returned task object comes from RETURNING, which would look
 *  equally stale if the SET never reached the column). PGlite's raw
 *  execute returns timestamptz as an ISO string, hence the union type. */
async function getRawTask(id: string): Promise<
  | {
      status: string;
      owner_node_id: string | null;
      lease_expires_at: string | Date | null;
      result: string | null;
    }
  | undefined
> {
  const rows = (
    await harness.db.execute(
      sql`SELECT "status", "owner_node_id", "lease_expires_at", "result" FROM "agent_tasks" WHERE "id" = ${id}::uuid`,
    )
  ).rows as {
    status: string;
    owner_node_id: string | null;
    lease_expires_at: string | Date | null;
    result: string | null;
  }[];
  return rows[0];
}

/** Epoch-ms of a raw timestamptz cell (string or Date), 0 for NULL. */
function leaseMs(value: string | Date | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

describe('updateTaskStatus (PGlite)', () => {
  beforeEach(async () => {
    await resetDb(harness.db, ['agent_tasks']);
  });

  it('claims an unowned task: owner_node_id is written and a lease is granted', async () => {
    // Regression for TWO stacked bugs: (a) the set-object used snake_case
    // keys (owner_node_id / lease_expires_at) which drizzle silently
    // dropped, and (b) the WHERE required owner_node_id = caller, which
    // an unowned (NULL-owner) task could never match — so the claim path
    // documented in the function comment was dead on both ends.
    const id = await seedTask(); // pending, owner NULL, lease NULL

    const task = await updateTaskStatus(id, 'running', undefined, {
      ownerNodeId: 'node-a',
    });

    expect(task).not.toBeNull();
    expect(task?.ownerNodeId).toBe('node-a');
    const raw = await getRawTask(id);
    expect(raw?.status).toBe('running');
    expect(raw?.owner_node_id).toBe('node-a');
    // The running flip granted a fresh lease (in the future).
    expect(raw?.lease_expires_at).not.toBeNull();
    expect(leaseMs(raw?.lease_expires_at)).toBeGreaterThan(Date.now());
  });

  it('rejects a status update from a node that does NOT own the row (returns null → 409)', async () => {
    const id = await seedTask({
      status: 'running',
      ownerNodeId: 'node-a',
      withLease: true,
    });

    const task = await updateTaskStatus(id, 'completed', 'done', {
      ownerNodeId: 'node-b',
    });

    // updateTaskStatus returns undefined when the guarded UPDATE matched
    // no row (the route maps that to 409).
    expect(task).toBeUndefined();
    // Row untouched: still owned by node-a, still running, lease intact.
    const raw = await getRawTask(id);
    expect(raw?.status).toBe('running');
    expect(raw?.owner_node_id).toBe('node-a');
    expect(raw?.lease_expires_at).not.toBeNull();
  });

  it('the owner can update, and a terminal status clears the lease', async () => {
    const id = await seedTask({
      status: 'running',
      ownerNodeId: 'node-a',
      withLease: true,
    });

    const task = await updateTaskStatus(id, 'completed', 'done', {
      ownerNodeId: 'node-a',
    });

    expect(task).not.toBeNull();
    const raw = await getRawTask(id);
    expect(raw?.status).toBe('completed');
    expect(raw?.result).toBe('done');
    // Terminal statuses clear lease_expires_at — the snake_case variant of
    // this assignment was ALSO silently dropped, leaving stale leases that
    // kept terminal rows in the partial index. Now it must be NULL.
    expect(raw?.lease_expires_at).toBeNull();
  });

  it('renews the lease on an owner in-flight → in-flight transition', async () => {
    const id = await seedTask({
      status: 'pending',
      ownerNodeId: 'node-a',
      withLease: true,
    });

    // Assert the renewal reaches the expected deadline — now() +
    // TASK_LEASE_SECONDS — not merely "greater than the old value".
    // Bracket the call so the exact deadline is pinned between the
    // pre-call and post-call clocks (fake timers are avoided: PGlite's
    // query loop depends on real timers).
    const startMs = Date.now();
    const task = await updateTaskStatus(id, 'reviewing', undefined, {
      ownerNodeId: 'node-a',
    });
    const endMs = Date.now();

    // A guarded UPDATE matching no row returns undefined — assert
    // defined (not merely not-null) so that regression is detected.
    expect(task).toBeDefined();
    const after = await getRawTask(id);
    expect(after?.status).toBe('reviewing');
    expect(after?.owner_node_id).toBe('node-a');
    const renewedLeaseMs = leaseMs(after?.lease_expires_at);
    expect(renewedLeaseMs).toBeGreaterThanOrEqual(
      startMs + TASK_LEASE_SECONDS * 1000,
    );
    expect(renewedLeaseMs).toBeLessThanOrEqual(
      endMs + TASK_LEASE_SECONDS * 1000,
    );
  });

  it('legacy caller (no ownerNodeId) updates unconditionally', async () => {
    const id = await seedTask({
      status: 'running',
      ownerNodeId: 'node-a',
      withLease: true,
    });

    const task = await updateTaskStatus(id, 'failed', 'boom');

    expect(task).not.toBeNull();
    const raw = await getRawTask(id);
    expect(raw?.status).toBe('failed');
    expect(raw?.result).toBe('boom');
    // Terminal status clears the lease on the unconditional path too.
    expect(raw?.lease_expires_at).toBeNull();
    // Ownership is not rewritten when no ownerNodeId option is passed.
    expect(raw?.owner_node_id).toBe('node-a');
  });
});
