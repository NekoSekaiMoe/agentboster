/**
 * Regression test for the workspace hard-delete cleanup loop.
 *
 * Bug being pinned: cleanupChatSession DELETES each session row, so the
 * old loop paginated listSessions with an advancing offset — with more
 * than one page of sessions, every session past the first page was
 * skipped by the cleanup (then deleted row-only, leaking sandboxes /
 * workflow runs / daemon sessions). The fix always reads offset 0 and
 * lets deletions drain the list, tracking processed ids so sessions
 * whose cleanup failed (and therefore keep their row) cannot spin the
 * loop forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    cleanupChatSession: vi.fn(),
    deleteLongTermMemoriesByWorkspaceId: vi.fn(),
    deleteBuiltinMemoriesByWorkspaceId: vi.fn(),
    deleteSessionsByWorkspaceId: vi.fn(),
    deleteWorkspaceRow: vi.fn(),
  },
  state: {
    // Live session table: the cleanup mock deletes rows from it, exactly
    // like the real cleanupChatSession → deleteSession.
    rows: [] as Array<{ id: string; sandboxId: null; workflowRunId: null }>,
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth/access', () => ({
  requireAuthAccess: vi.fn(async () => ({
    session: { userId: 'owner-1' },
    user: { roles: [] },
  })),
  AuthError: class AuthError extends Error {},
}));

vi.mock('@/lib/core/db/agentd', () => ({
  resolveWorkspaceAccess: vi.fn(async () => ({
    ws: { id: 'ws-1', ownerId: 'owner-1', isDefault: false },
    canAccess: true,
    canManage: true,
  })),
  deleteWorkspaceRow: mocks.deleteWorkspaceRow,
}));

vi.mock('@/lib/core/db', () => ({ db: {} }));

vi.mock('@/lib/core/db/chat', () => ({
  listSessions: vi.fn(
    async ({ limit, offset }: { limit: number; offset: number }) =>
      state.rows.slice(offset, offset + limit),
  ),
  deleteSessionsByWorkspaceId: mocks.deleteSessionsByWorkspaceId,
}));

vi.mock('@/lib/chat/session-cleanup', () => ({
  cleanupChatSession: mocks.cleanupChatSession,
}));

vi.mock('@/lib/core/db/memory/long-term', () => ({
  deleteLongTermMemoriesByWorkspaceId:
    mocks.deleteLongTermMemoriesByWorkspaceId,
}));

vi.mock('@/lib/core/db/memory/builtin', () => ({
  deleteBuiltinMemoriesByWorkspaceId: mocks.deleteBuiltinMemoriesByWorkspaceId,
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { DELETE } from './route';

function seedSessions(count: number) {
  state.rows = Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    sandboxId: null,
    workflowRunId: null,
  }));
}

async function hardDelete() {
  const request = new Request(
    'http://localhost/api/workspaces/ws-1?hard=true',
    {
      method: 'DELETE',
    },
  );
  const response = await DELETE(request, {
    params: Promise.resolve({ id: 'ws-1' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('DELETE /api/workspaces/[id]?hard=true — cleanup pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [];
    mocks.deleteLongTermMemoriesByWorkspaceId.mockResolvedValue(0);
    mocks.deleteBuiltinMemoriesByWorkspaceId.mockResolvedValue(0);
    mocks.deleteSessionsByWorkspaceId.mockImplementation(async () =>
      state.rows.map((row) => row.id),
    );
    mocks.deleteWorkspaceRow.mockResolvedValue(true);
  });

  it('cleans up EVERY session across pages (offset-0 drain, no skips)', async () => {
    // 250 sessions > one 200-row page: the old advancing-offset loop
    // cleaned 200 and silently skipped the remaining 50.
    seedSessions(250);
    mocks.cleanupChatSession.mockImplementation(
      async (session: { id: string }) => {
        state.rows = state.rows.filter((row) => row.id !== session.id);
        return { deleted: true };
      },
    );

    const { status, body } = await hardDelete();

    expect(status).toBe(200);
    expect(mocks.cleanupChatSession).toHaveBeenCalledTimes(250);
    const cleanedIds = new Set(
      mocks.cleanupChatSession.mock.calls.map(([session]) => session.id),
    );
    expect(cleanedIds.size).toBe(250);
    expect(body.success).toBe(true);
    expect(body.data.cleanupsFailed).toBe(0);
  });

  it('terminates when cleanups keep failing (processed-id guard) and counts the failures', async () => {
    // Failed cleanups leave their rows behind; without the processed-id
    // guard the offset-0 loop would re-attempt the same page forever.
    seedSessions(5);
    mocks.cleanupChatSession.mockRejectedValue(new Error('sandbox down'));

    const { status, body } = await hardDelete();

    expect(status).toBe(200);
    // Each failing session attempted exactly once — no infinite loop.
    expect(mocks.cleanupChatSession).toHaveBeenCalledTimes(5);
    expect(body.data.cleanupsFailed).toBe(5);
    // The leftover rows are still hard-deleted afterwards.
    expect(mocks.deleteSessionsByWorkspaceId).toHaveBeenCalledWith('ws-1');
    expect(body.data.sessionsDeleted).toBe(5);
  });

  it('partial failures still reach later pages', async () => {
    // 250 sessions; the first 200 clean up fine, the last 50 fail — every
    // session must be ATTEMPTED exactly once.
    seedSessions(250);
    mocks.cleanupChatSession.mockImplementation(
      async (session: { id: string }) => {
        const index = Number(session.id.replace('session-', ''));
        if (index > 200) throw new Error('daemon unreachable');
        state.rows = state.rows.filter((row) => row.id !== session.id);
        return { deleted: true };
      },
    );

    const { status, body } = await hardDelete();

    expect(status).toBe(200);
    expect(mocks.cleanupChatSession).toHaveBeenCalledTimes(250);
    expect(body.data.cleanupsFailed).toBe(50);
    expect(body.data.sessionsDeleted).toBe(50);
  });
});
