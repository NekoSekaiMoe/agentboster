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

const { failoverOfflineWorkspaces } = await import('./workspace-failover');

beforeEach(() => {
  vi.clearAllMocks();
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
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockImplementation(() => conditionalUpdate(STALE_NODE_ID)),
        }),
      }),
    });

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
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockImplementation(() => conditionalUpdate(STALE_NODE_ID)),
        }),
      }),
    });

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
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockImplementation(() => conditionalUpdate(STALE_NODE_ID)),
        }),
      }),
    });

    const migrated = await failoverOfflineWorkspaces();

    expect(selectCalls).toBe(1);
    expect(migrated).toBe(0);
    expect(state.workspace.nodeGeneration).toBe(1);
    expect(state.workspace.preferredNodeId).toBe(STALE_NODE_ID);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
