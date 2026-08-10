/**
 * Tests for the workspace run-lock acquire/release layer.
 *
 * Covers three review findings:
 *  FIX 1 — acquireRunLockStep must carry the session's resolved workspace
 *          ID (resolvedWorkspaceId) even when the lock itself is NOT
 *          acquired, so post-run memory extraction never falls back to the
 *          global layer for a workspace-scoped session.
 *  FIX 2 — workspace_id and node_generation are REQUIRED in the acquire
 *          response schema: a 200 payload missing either must be treated
 *          as NOT acquired, never returned as acquired:true.
 *  FIX 3 — the fencing token (nodeGeneration) captured at acquire time
 *          must be forwarded on release as `node_generation` in the
 *          release POST body; omitted (not null/undefined) when absent.
 *
 * The module under test resolves its DB / agentd HTTP deps via dynamic
 * `await import(...)`, so vi.mock on those module paths is sufficient
 * (same pattern as barrier.test.ts / dispatch.test.ts).
 *
 * Run via: yarn test lib/workflow/agent/workspace-lock.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ────────────────────────────────────────────────────────
//
// acquireRunLockStep issues two select chains: first against `sessions`
// (workspace id), then against `workspaces` (preferred node + fencing
// generation). The schema module is mocked with marker tables so the
// `from()` call can tell which chain is being executed.

const dbRows = {
  sessionRows: [] as Array<{ workspaceId: string | null }>,
  workspaceRows: [] as Array<{
    preferredNodeId: string | null;
    nodeGeneration: number | null;
  }>,
  /** Test-only: make the sessions select reject (pre-resolution failure). */
  throwOnSessions: false,
  /** Test-only: make the workspaces select reject (post-resolution failure). */
  throwOnWorkspaces: false,
};

vi.mock('@/lib/core/db/schema', () => ({
  sessions: { __table: 'sessions' },
  workspaces: { __table: 'workspaces' },
}));

vi.mock('@/lib/core/db', () => ({
  db: {
    select: () => ({
      from: (table: { __table: string }) => ({
        where: () => ({
          limit: async () => {
            if (table.__table === 'sessions' && dbRows.throwOnSessions) {
              throw new Error('sessions db down');
            }
            if (table.__table === 'workspaces' && dbRows.throwOnWorkspaces) {
              throw new Error('workspaces db down');
            }
            return table.__table === 'sessions'
              ? dbRows.sessionRows
              : dbRows.workspaceRows;
          },
        }),
      }),
    }),
  },
}));

// ── agentd client / HTTP mocks ─────────────────────────────────────

const getConfigMock = vi.fn(
  async (_nodeId: string) =>
    ({ baseUrl: 'http://agentd.test', apiKey: 'k' }) as unknown,
);
vi.mock('@/lib/extra/agent/agentd-tools-client', () => ({
  getAgentdClientConfigByNodeId: getConfigMock,
}));

const requestAgentdMock = vi.fn(
  async (
    _config: unknown,
    _method: string,
    _path: string,
    _body?: unknown,
    _timeoutMs?: number,
  ): Promise<{ status: number; text: string }> => ({
    status: 200,
    text: '{}',
  }),
);
vi.mock('@/lib/extra/agent/agentd-http', () => ({
  requestAgentd: requestAgentdMock,
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

const {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  acquireRunLockStep,
  releaseRunLockStep,
} = await import('./workspace-lock');

function seedDb(opts: {
  workspaceId?: string | null;
  preferredNodeId?: string | null;
  nodeGeneration?: number | null;
}) {
  dbRows.sessionRows =
    opts.workspaceId === undefined
      ? [{ workspaceId: 'ws-1' }]
      : [{ workspaceId: opts.workspaceId }];
  dbRows.workspaceRows = [
    {
      preferredNodeId:
        opts.preferredNodeId === undefined ? 'node-1' : opts.preferredNodeId,
      nodeGeneration:
        opts.nodeGeneration === undefined ? 7 : opts.nodeGeneration,
    },
  ];
}

function acquiredBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      workspace_id: 'ws-1',
      holder_type: 'chat_run',
      exec_session_id: 'run-1',
      node_generation: 7,
      acquired_at: '2025-01-01T00:00:00Z',
      expires_at: '2025-01-01T02:00:00Z',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDb({});
  dbRows.throwOnSessions = false;
  dbRows.throwOnWorkspaces = false;
  getConfigMock.mockResolvedValue({
    baseUrl: 'http://agentd.test',
    apiKey: 'k',
  });
});

// ── FIX 2: required fields in the acquire schema ──────────────────

describe('acquireWorkspaceLock schema strictness (FIX 2)', () => {
  it('treats a 200 payload missing node_generation as NOT acquired', async () => {
    const body = acquiredBody();
    delete (body.data as Record<string, unknown>).node_generation;
    requestAgentdMock.mockResolvedValueOnce({
      status: 200,
      text: JSON.stringify(body),
    });
    const result = await acquireWorkspaceLock({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: 7,
    });
    expect(result.acquired).toBe(false);
    expect(result.state).toBeUndefined();
  });

  it('treats a 200 payload missing workspace_id as NOT acquired', async () => {
    const body = acquiredBody();
    delete (body.data as Record<string, unknown>).workspace_id;
    requestAgentdMock.mockResolvedValueOnce({
      status: 200,
      text: JSON.stringify(body),
    });
    const result = await acquireWorkspaceLock({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: 7,
    });
    expect(result.acquired).toBe(false);
    expect(result.state).toBeUndefined();
  });

  it('returns acquired:true with state for a well-formed 200 payload', async () => {
    requestAgentdMock.mockResolvedValueOnce({
      status: 200,
      text: JSON.stringify(acquiredBody()),
    });
    const result = await acquireWorkspaceLock({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: 7,
    });
    expect(result.acquired).toBe(true);
    expect(result.state?.workspace_id).toBe('ws-1');
    expect(result.state?.node_generation).toBe(7);
  });
});

// ── FIX 1: resolvedWorkspaceId on the handle ──────────────────────

describe('acquireRunLockStep resolvedWorkspaceId (FIX 1)', () => {
  it('carries the session workspace ID even when the lock is busy (409)', async () => {
    requestAgentdMock.mockResolvedValueOnce({
      status: 409,
      text: JSON.stringify({ data: { holder: { exec_session_id: 'other' } } }),
    });
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.workspaceId).toBeNull();
    expect(handle.execSessionId).toBeNull();
    expect(handle.nodeGeneration).toBeNull();
    // The resolved workspace id is still populated for cleanup scoping.
    expect(handle.resolvedWorkspaceId).toBe('ws-1');
  });

  it('carries the session workspace ID when there is no preferred node', async () => {
    seedDb({ preferredNodeId: null });
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.workspaceId).toBeNull();
    expect(handle.resolvedWorkspaceId).toBe('ws-1');
  });

  it('returns a fully empty handle when the session has no workspace', async () => {
    seedDb({ workspaceId: null });
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.workspaceId).toBeNull();
    expect(handle.resolvedWorkspaceId).toBeNull();
    expect(handle.nodeGeneration).toBeNull();
  });

  it('populates nodeGeneration from the acquire response on success', async () => {
    requestAgentdMock.mockResolvedValueOnce({
      status: 200,
      text: JSON.stringify(acquiredBody({ node_generation: 42 })),
    });
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.workspaceId).toBe('ws-1');
    expect(handle.execSessionId).toBe('run-1');
    expect(handle.nodeGeneration).toBe(42);
    expect(handle.resolvedWorkspaceId).toBe('ws-1');
  });

  it('keeps resolvedWorkspaceId when the error occurs AFTER workspace resolution', async () => {
    // Simulate a failure past the point where the session's workspace id
    // has been resolved (here: the workspaces-table select rejects). The
    // catch path must still carry resolvedWorkspaceId so post-run cleanup
    // does not fall back to the global memory layer — but all lock fields
    // stay null (no lock was acquired).
    dbRows.throwOnWorkspaces = true;
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.resolvedWorkspaceId).toBe('ws-1');
    expect(handle.nodeId).toBeNull();
    expect(handle.workspaceId).toBeNull();
    expect(handle.execSessionId).toBeNull();
    expect(handle.nodeGeneration).toBeNull();
  });

  it('returns a fully empty handle when the error occurs BEFORE workspace resolution', async () => {
    dbRows.throwOnSessions = true;
    const handle = await acquireRunLockStep('sess-1', 'run-1');
    expect(handle.resolvedWorkspaceId).toBeNull();
    expect(handle.workspaceId).toBeNull();
    expect(handle.nodeId).toBeNull();
    expect(handle.nodeGeneration).toBeNull();
  });
});

// ── FIX 3: fencing token on release ───────────────────────────────

describe('release fencing token (FIX 3)', () => {
  it('includes node_generation in the release body when present', async () => {
    await releaseWorkspaceLock({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: 7,
    });
    expect(requestAgentdMock).toHaveBeenCalledTimes(1);
    const [, method, path, body] = requestAgentdMock.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/v1/workspaces/ws-1/lock/release');
    expect(body).toEqual({ exec_session_id: 'run-1', node_generation: 7 });
  });

  it('omits node_generation entirely when no generation is available', async () => {
    await releaseWorkspaceLock({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: null,
    });
    const body = requestAgentdMock.mock.calls[0][3] as Record<string, unknown>;
    expect(body).toEqual({ exec_session_id: 'run-1' });
    expect('node_generation' in body).toBe(false);
  });

  it('releaseRunLockStep forwards the handle fencing token', async () => {
    await releaseRunLockStep({
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      execSessionId: 'run-1',
      nodeGeneration: 42,
      resolvedWorkspaceId: 'ws-1',
    });
    const [, , , body] = requestAgentdMock.mock.calls[0];
    expect(body).toEqual({ exec_session_id: 'run-1', node_generation: 42 });
  });

  it('releaseRunLockStep is a no-op for an empty handle (no release call)', async () => {
    await releaseRunLockStep({
      nodeId: null,
      workspaceId: null,
      execSessionId: null,
      nodeGeneration: null,
      resolvedWorkspaceId: 'ws-1',
    });
    expect(requestAgentdMock).not.toHaveBeenCalled();
  });
});
