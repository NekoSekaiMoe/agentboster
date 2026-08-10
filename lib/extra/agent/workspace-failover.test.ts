import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the workspace failover detector's atomicity.
 *
 * The stale-workspace transition must be a single conditional UPDATE
 * whose WHERE clause rechecks everything the stale-select filtered on
 * (status, original preferred_node_id, node-expiration predicate), with
 * the RETURNING result as the SOLE condition for the failover
 * notification. These tests simulate the DB layer with a chainable mock
 * (same pattern as lib/workflow/agent/tools/agentd/nodes.test.ts) whose
 * `returning()` evaluates the conditional predicate against shared,
 * mutable "database" state — mirroring what Postgres would do with the
 * real conditional WHERE.
 */

// ─── Simulated database state ────────────────────────────────────────
const STALE_NODE_ID = 'node-stale';
const WORKSPACE_ID = 'ws-1';
const OWNER_ID = 'user-1';
// 10 minutes old — past FAILOVER_GRACE_MS (5 min).
const STALE_HEARTBEAT = () => new Date(Date.now() - 10 * 60_000);

interface SimState {
  workspace: {
    id: string;
    ownerId: string;
    name: string;
    status: string;
    preferredNodeId: string | null;
    nodeGeneration: number;
  };
  /** null simulates a missing agentd_nodes row (unregistered zombie). */
  nodeHeartbeat: Date | null;
  nodeRowExists: boolean;
}

function freshState(): SimState {
  return {
    workspace: {
      id: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: 'Default',
      status: 'active',
      preferredNodeId: STALE_NODE_ID,
      nodeGeneration: 1,
    },
    nodeHeartbeat: STALE_HEARTBEAT(),
    nodeRowExists: true,
  };
}

let state: SimState;

// ─── Chainable db mock ───────────────────────────────────────────────
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockCreateNotification = vi.fn();
const mockResolveTarget = vi.fn();

/**
 * Every drizzle condition passed to the update chain's `.where()`, in
 * call order. The behavioral tests below evaluate the predicate against
 * simulated state; the drift-guard tests at the bottom compile these
 * captured conditions through drizzle's PgDialect and assert on the
 * generated SQL/params (same pattern as lib/core/db/memory/long-term.test.ts).
 */
const capturedWhereConditions: unknown[] = [];

/**
 * Chainable mock for db.update(workspaces).set(...).where(cond).returning().
 * Records the drizzle condition handed to `.where()` so tests can inspect
 * the ACTUAL predicate the production code built (instead of trusting the
 * TS re-implementation in conditionalUpdate below), then evaluates the
 * conditional-UPDATE semantics against shared state.
 */
function mockUpdateChain(scannedNodeId: string | null = STALE_NODE_ID) {
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((condition: unknown) => {
        capturedWhereConditions.push(condition);
        return {
          returning: vi
            .fn()
            .mockImplementation(() => conditionalUpdate(scannedNodeId)),
        };
      }),
    }),
  });
}

/** Mirrors the stale-select predicate in failoverOfflineWorkspaces. */
function selectStaleRows() {
  const ws = state.workspace;
  const nodeStale =
    !state.nodeRowExists ||
    state.nodeHeartbeat === null ||
    state.nodeHeartbeat.getTime() < Date.now() - 5 * 60_000;
  if (ws.status === 'active' && ws.preferredNodeId !== null && nodeStale) {
    // Snapshot semantics: the row the scanner read at select time.
    return [
      {
        id: ws.id,
        ownerId: ws.ownerId,
        name: ws.name,
        preferredNodeId: ws.preferredNodeId,
      },
    ];
  }
  return [];
}

/**
 * Mirrors the conditional UPDATE ... RETURNING: the predicate rechecks
 * the original preferredNodeId, active status, and the node-expiration
 * condition against CURRENT state, exactly like the SQL WHERE clause.
 */
function conditionalUpdate(scannedNodeId: string | null): { id: string }[] {
  const ws = state.workspace;
  const nodeStillStale =
    !state.nodeRowExists ||
    state.nodeHeartbeat === null ||
    state.nodeHeartbeat.getTime() < Date.now() - 5 * 60_000;
  const matches =
    ws.status === 'active' &&
    ws.preferredNodeId !== null &&
    ws.preferredNodeId === scannedNodeId &&
    nodeStillStale;
  if (!matches) return [];
  ws.preferredNodeId = null;
  ws.nodeGeneration += 1;
  return [{ id: ws.id }];
}

vi.mock('@/lib/core/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));

vi.mock('@/lib/core/db/notification', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('@/lib/extra/agent/workspace-delivery', () => ({
  resolveWorkspaceDeliveryTarget: mockResolveTarget,
}));

const { FAILOVER_GRACE_MS, failoverOfflineWorkspaces } = await import(
  './workspace-failover'
);

const dialect = new PgDialect();

/** Compile a captured drizzle condition to SQL text + bound params. */
function compileWhere(condition: unknown) {
  return dialect.sqlToQuery(condition as SQL);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedWhereConditions.length = 0;
  state = freshState();
  mockCreateNotification.mockResolvedValue({});
  mockResolveTarget.mockResolvedValue({
    channel: 'web',
    targetChatId: `web:${OWNER_ID}`,
    targetUserId: null,
  });
});

describe('failoverOfflineWorkspaces', () => {
  it('fails over a stale workspace exactly once', async () => {
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => selectStaleRows()),
        }),
      }),
    });
    mockUpdateChain();

    const migrated = await failoverOfflineWorkspaces();

    expect(migrated).toBe(1);
    expect(state.workspace.nodeGeneration).toBe(2);
    expect(state.workspace.preferredNodeId).toBeNull();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER_ID,
        notificationType: 'workspace_failover',
        channel: 'web',
      }),
    );
  });

  it('two racing scanners increment nodeGeneration exactly once and send exactly one notification', async () => {
    // NOTE on methodology: the ideal test would run two
    // failoverOfflineWorkspaces() calls via Promise.all. Vitest (3.2.6)
    // has a module-runner race where CONCURRENT dynamic import()s of a
    // vi.mock'ed module can bypass the mock and load the real module
    // (reproduced minimally: two in-flight `await import('@/lib/core/db')`
    // calls, one returns the real db Proxy). So instead we emulate the
    // race window — both scanners read the SAME stale snapshot before
    // either writes — by preloading two stale snapshots into the select
    // mock, then running the scanners sequentially. The mock's
    // conditionalUpdate evaluates the conditional-WHERE predicate against
    // live state exactly as Postgres would, so the loser's UPDATE still
    // matches zero rows, which is the invariant under test.
    const staleSnapshot = [
      {
        id: WORKSPACE_ID,
        ownerId: OWNER_ID,
        name: 'Default',
        preferredNodeId: STALE_NODE_ID,
      },
    ];
    let selectCalls = 0;
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCalls += 1;
            // First two selects = both scanners reading before either
            // writes (the race window). Any later sweep sees live state.
            if (selectCalls <= 2) return staleSnapshot;
            return selectStaleRows();
          }),
        }),
      }),
    });
    mockUpdateChain();

    const migratedA = await failoverOfflineWorkspaces();
    const migratedB = await failoverOfflineWorkspaces();

    // Both scanners read the same stale row; exactly one may win the
    // conditional update.
    expect(migratedA).toBe(1);
    expect(migratedB).toBe(0);
    expect(state.workspace.nodeGeneration).toBe(2);
    expect(state.workspace.preferredNodeId).toBeNull();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('aborts the failover (and notification) when the node heartbeats between select and update', async () => {
    let selectCalls = 0;
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCalls += 1;
            const rows = selectStaleRows();
            // Simulate a fresh heartbeat landing right after the scanner
            // read the stale row.
            state.nodeHeartbeat = new Date();
            return rows;
          }),
        }),
      }),
    });
    mockUpdateChain();

    const migrated = await failoverOfflineWorkspaces();

    expect(selectCalls).toBe(1);
    expect(migrated).toBe(0);
    expect(state.workspace.nodeGeneration).toBe(1);
    expect(state.workspace.preferredNodeId).toBe(STALE_NODE_ID);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('conditional UPDATE predicate (drift guard)', () => {
  // The behavioral tests above trust conditionalUpdate()'s TS re-implementation
  // of the WHERE predicate. These tests instead inspect the ACTUAL drizzle
  // condition the production code passed to `.where()` — compiled through
  // PgDialect — so dropping a condition from workspace-failover.ts turns a
  // test red instead of silently staying green.
  it('WHERE rechecks workspace id, active status, original preferred node, and node expiration', async () => {
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => selectStaleRows()),
        }),
      }),
    });
    mockUpdateChain();

    await failoverOfflineWorkspaces();

    expect(capturedWhereConditions).toHaveLength(1);
    const where = compileWhere(capturedWhereConditions[0]);

    // Workspace identity + active-status recheck.
    expect(where.sql).toContain('"id"');
    expect(where.sql).toContain('"status"');
    expect(where.params).toContain(WORKSPACE_ID);
    expect(where.params).toContain('active');

    // Original preferred_node_id (the scanned value, not just IS NOT NULL).
    expect(where.sql).toContain('"preferred_node_id"');
    expect(where.params).toContain(STALE_NODE_ID);

    // Node-expiration predicate: NOT EXISTS (missing node row) OR EXISTS
    // (heartbeat older than the grace cutoff), joining agentd_nodes on
    // node_id against the workspace's preferred_node_id.
    expect(where.sql).toContain('NOT EXISTS');
    expect(where.sql).toContain('EXISTS');
    expect(where.sql).toContain('agentd_nodes');
    expect(where.sql).toContain('node_id');
    expect(where.sql).toContain('last_heartbeat');

    // The staleness cutoff is a bound param ~FAILOVER_GRACE_MS in the past.
    const cutoff = where.params.find((p): p is Date => p instanceof Date);
    expect(cutoff).toBeInstanceOf(Date);
    if (cutoff) {
      const ageMs = Date.now() - cutoff.getTime();
      expect(ageMs).toBeGreaterThanOrEqual(FAILOVER_GRACE_MS);
      expect(ageMs).toBeLessThan(FAILOVER_GRACE_MS + 60_000);
    }
  });

  it('every racing scanner issues the full predicate, not a weakened one', async () => {
    const staleSnapshot = [
      {
        id: WORKSPACE_ID,
        ownerId: OWNER_ID,
        name: 'Default',
        preferredNodeId: STALE_NODE_ID,
      },
    ];
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(staleSnapshot),
        }),
      }),
    });
    mockUpdateChain();

    await failoverOfflineWorkspaces();
    await failoverOfflineWorkspaces();

    // Both scanners must build the identical full predicate.
    expect(capturedWhereConditions).toHaveLength(2);
    for (const condition of capturedWhereConditions) {
      const where = compileWhere(condition);
      expect(where.sql).toContain('"status"');
      expect(where.sql).toContain('"preferred_node_id"');
      expect(where.sql).toContain('last_heartbeat');
      expect(where.params).toContain(WORKSPACE_ID);
      expect(where.params).toContain('active');
      expect(where.params).toContain(STALE_NODE_ID);
    }
  });
});
