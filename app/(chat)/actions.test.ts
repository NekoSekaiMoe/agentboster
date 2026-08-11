/**
 * Tests for the session-list server actions in app/(chat)/actions.ts:
 *
 *  - listRecentSessionsAction
 *      · workspace branch threads workspaceId into the SQL query (no
 *        post-LIMIT filtering that would return short pages);
 *      · admin branch derives manageOnly via resolveSessionGrant so a
 *        shared session in a workspace the admin cannot access stays
 *        locked, with grant resolution memoized per (workspace,
 *        visibility) to avoid N+1 workspace lookups.
 *  - setSessionVisibilityAction / deleteSessionAction
 *      · expected failures RETURN { success: false, error } with the
 *        documented codes instead of throwing (contract consumed by
 *        components/config/sections/workspace-sessions-table.tsx).
 *
 * All persistence/auth collaborators are mocked; these tests pin the
 * branching and the return contract, not the DB.
 *
 * Run via: yarn test "app/(chat)/actions.test.ts"
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth/access', () => {
  class AuthError extends Error {
    readonly status: number;
    constructor(message: 'Unauthorized' | 'Forbidden', status: number) {
      super(message);
      this.name = 'AuthError';
      this.status = status;
    }
  }
  return { AuthError, requireAuthAccess: vi.fn() };
});

vi.mock('@/lib/chat/session-access', () => ({
  assertCanManageSharedSession: vi.fn(),
  resolveSessionGrant: vi.fn(),
}));

vi.mock('@/lib/core/db/chat', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  listVisibleSessions: vi.fn(),
  updateSession: vi.fn(),
  updateSessionForUser: vi.fn(),
  updateSessionMetadataKey: vi.fn(),
}));

vi.mock('@/lib/core/db/agentd', () => ({
  listVisibleWorkspaces: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/chat/session-cleanup', () => ({
  cleanupChatSession: vi.fn(),
}));

vi.mock('@/lib/core/sandbox', () => ({
  stopSessionSandbox: vi.fn(),
}));

vi.mock('@/lib/core/sandbox/runtime', () => ({
  nowIso: () => '2025-01-01T00:00:00.000Z',
  patchWorkflowRuntime: vi.fn(),
}));

vi.mock('@/lib/core/sandbox/session-runtime', () => ({
  getSessionRuntime: vi.fn(),
}));

vi.mock('@/lib/core/db', () => ({
  db: { execute: vi.fn() },
}));

vi.mock('@/lib/core/kv/config', () => ({
  getConfig: vi.fn(async () => ({})),
}));

vi.mock('@/lib/workflow/agent/dispatch', () => ({
  resumeToolApproval: vi.fn(),
}));

vi.mock('workflow/api', () => ({
  getRun: vi.fn(),
}));

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import {
  assertCanManageSharedSession,
  resolveSessionGrant,
} from '@/lib/chat/session-access';
import { cleanupChatSession } from '@/lib/chat/session-cleanup';
import {
  getSession,
  listSessions,
  listVisibleSessions,
  updateSessionForUser,
} from '@/lib/core/db/chat';
import { resolveWorkspaceAccess } from '@/lib/core/db/agentd';
import {
  deleteSessionAction,
  listRecentSessionsAction,
  setSessionVisibilityAction,
} from './actions';

const mockRequireAuth = vi.mocked(requireAuthAccess);
const mockAssertManage = vi.mocked(assertCanManageSharedSession);
const mockResolveGrant = vi.mocked(resolveSessionGrant);
const mockGetSession = vi.mocked(getSession);
const mockListSessions = vi.mocked(listSessions);
const mockListVisible = vi.mocked(listVisibleSessions);
const mockUpdateForUser = vi.mocked(updateSessionForUser);
const mockCleanup = vi.mocked(cleanupChatSession);
const mockResolveWs = vi.mocked(resolveWorkspaceAccess);

const USER_ID = 'user-1';

function makeAccess(overrides: Record<string, unknown> = {}) {
  return {
    session: { userId: USER_ID },
    isAdmin: false,
    user: { roles: [] as string[] },
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test double for the auth access shape
  } as any;
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    userId: USER_ID,
    workspaceId: null,
    visibility: 'private',
    title: 'Chat',
    channel: 'web',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    metadata: null,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: partial session row double
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(makeAccess());
});

describe('setSessionVisibilityAction', () => {
  it('returns invalid_input for a runtime-invalid visibility value', async () => {
    const result = await setSessionVisibilityAction({
      id: 's-1',
      // Server-action payloads are not type-checked at runtime.
      visibility: 'public' as 'private',
    });
    expect(result).toEqual({ success: false, error: 'invalid_input' });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns invalid_input for a blank id', async () => {
    const result = await setSessionVisibilityAction({
      id: '   ',
      visibility: 'private',
    });
    expect(result).toEqual({ success: false, error: 'invalid_input' });
  });

  it('returns not_found when the session does not exist', async () => {
    mockGetSession.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getSession>>,
    );
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'private',
    });
    expect(result).toEqual({ success: false, error: 'not_found' });
  });

  it('returns forbidden when the access gate denies the actor', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow());
    mockAssertManage.mockRejectedValue(new AuthError('Forbidden', 403));
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'private',
    });
    expect(result).toEqual({ success: false, error: 'forbidden' });
  });

  it.each(['shared', 'manage'] as const)(
    'returns forbidden for the non-owner %s grant',
    async (grant) => {
      mockGetSession.mockResolvedValue(makeSessionRow());
      mockAssertManage.mockResolvedValue(grant);
      const result = await setSessionVisibilityAction({
        id: 's-1',
        visibility: 'shared',
      });
      expect(result).toEqual({ success: false, error: 'forbidden' });
      expect(mockUpdateForUser).not.toHaveBeenCalled();
    },
  );

  it('returns invalid_input when sharing a session outside any workspace', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow({ workspaceId: null }));
    mockAssertManage.mockResolvedValue('owner');
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'shared',
    });
    expect(result).toEqual({ success: false, error: 'invalid_input' });
  });

  it('returns invalid_input when the workspace is not public', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow({ workspaceId: 'ws-1' }));
    mockAssertManage.mockResolvedValue('owner');
    mockResolveWs.mockResolvedValue({
      ws: { visibility: 'private' },
      canAccess: true,
      canManage: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial workspace access double
    } as any);
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'shared',
    });
    expect(result).toEqual({ success: false, error: 'invalid_input' });
  });

  it('persists a private visibility change for the owner', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow({ workspaceId: 'ws-1' }));
    mockAssertManage.mockResolvedValue('owner');
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'private',
    });
    expect(result).toEqual({ success: true });
    expect(mockUpdateForUser).toHaveBeenCalledWith('s-1', USER_ID, {
      visibility: 'private',
    });
  });

  it('returns invalid_input when the workspace is archived (not active)', async () => {
    // archiveWorkspace leaves visibility at 'public', so the visibility
    // check alone is not enough — sharing must also be rejected when the
    // workspace is no longer active (matches the session search filter
    // and setWorkspaceVisibility's active gate).
    mockGetSession.mockResolvedValue(makeSessionRow({ workspaceId: 'ws-1' }));
    mockAssertManage.mockResolvedValue('owner');
    mockResolveWs.mockResolvedValue({
      ws: { visibility: 'public', status: 'archived' },
      canAccess: true,
      canManage: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial workspace access double
    } as any);
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'shared',
    });
    expect(result).toEqual({ success: false, error: 'invalid_input' });
    expect(mockUpdateForUser).not.toHaveBeenCalled();
  });

  it('persists sharing inside a public workspace', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow({ workspaceId: 'ws-1' }));
    mockAssertManage.mockResolvedValue('owner');
    mockResolveWs.mockResolvedValue({
      ws: { visibility: 'public', status: 'active' },
      canAccess: true,
      canManage: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial workspace access double
    } as any);
    const result = await setSessionVisibilityAction({
      id: 's-1',
      visibility: 'shared',
    });
    expect(result).toEqual({ success: true });
    expect(mockUpdateForUser).toHaveBeenCalledWith('s-1', USER_ID, {
      visibility: 'shared',
    });
  });
});

describe('deleteSessionAction', () => {
  it('returns invalid_input for a blank id', async () => {
    expect(await deleteSessionAction('  ')).toEqual({
      success: false,
      error: 'invalid_input',
    });
  });

  it('returns not_found when the session does not exist', async () => {
    mockGetSession.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getSession>>,
    );
    expect(await deleteSessionAction('s-1')).toEqual({
      success: false,
      error: 'not_found',
    });
  });

  it('returns forbidden when the access gate denies the actor', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow());
    mockAssertManage.mockRejectedValue(new AuthError('Forbidden', 403));
    expect(await deleteSessionAction('s-1')).toEqual({
      success: false,
      error: 'forbidden',
    });
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it('returns not_found when cleanup reports nothing deleted', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow());
    mockAssertManage.mockResolvedValue('owner');
    // biome-ignore lint/suspicious/noExplicitAny: partial cleanup result double
    mockCleanup.mockResolvedValue({ deleted: false } as any);
    expect(await deleteSessionAction('s-1')).toEqual({
      success: false,
      error: 'not_found',
    });
  });

  it('returns unknown when cleanup throws unexpectedly', async () => {
    mockGetSession.mockResolvedValue(makeSessionRow());
    mockAssertManage.mockResolvedValue('owner');
    mockCleanup.mockRejectedValue(new Error('db connection lost'));
    expect(await deleteSessionAction('s-1')).toEqual({
      success: false,
      error: 'unknown',
    });
  });

  it('deletes as the owner and scopes cleanup to the owner id', async () => {
    const session = makeSessionRow();
    mockGetSession.mockResolvedValue(session);
    mockAssertManage.mockResolvedValue('owner');
    // biome-ignore lint/suspicious/noExplicitAny: partial cleanup result double
    mockCleanup.mockResolvedValue({ deleted: true } as any);
    expect(await deleteSessionAction('s-1')).toEqual({ success: true });
    expect(mockCleanup).toHaveBeenCalledWith(session, { userId: USER_ID });
  });

  it('deletes via a manage grant without an owner-scoped cleanup', async () => {
    const session = makeSessionRow({ userId: 'someone-else' });
    mockGetSession.mockResolvedValue(session);
    mockAssertManage.mockResolvedValue('manage');
    // biome-ignore lint/suspicious/noExplicitAny: partial cleanup result double
    mockCleanup.mockResolvedValue({ deleted: true } as any);
    expect(await deleteSessionAction('s-1')).toEqual({ success: true });
    expect(mockCleanup).toHaveBeenCalledWith(session, { userId: undefined });
  });
});

describe('listRecentSessionsAction', () => {
  it('threads workspaceId into the SQL query instead of post-filtering rows', async () => {
    mockRequireAuth.mockResolvedValue(makeAccess());
    mockResolveWs.mockResolvedValue({
      ws: { visibility: 'public' },
      canAccess: true,
      canManage: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial workspace access double
    } as any);
    // The DAL applies the workspace filter in SQL; whatever it returns is
    // the page (previously rows from other workspaces were dropped here,
    // after LIMIT, producing short pages).
    mockListVisible.mockResolvedValue([
      makeSessionRow({ id: 's-1', workspaceId: 'ws-1' }),
      makeSessionRow({ id: 's-2', workspaceId: 'ws-2' }),
      // biome-ignore lint/suspicious/noExplicitAny: partial session row doubles
    ] as any);

    const rows = await listRecentSessionsAction({
      limit: 30,
      workspaceId: 'ws-1',
    });

    expect(mockListVisible).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        accessiblePublicWorkspaceIds: ['ws-1'],
        manageableWorkspaceIds: [],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(['s-1', 's-2']);
  });

  it('admin branch derives manageOnly from resolveSessionGrant, memoized per workspace+visibility', async () => {
    mockRequireAuth.mockResolvedValue(makeAccess({ isAdmin: true }));
    mockListSessions.mockResolvedValue([
      makeSessionRow({ id: 's-own', userId: USER_ID }),
      makeSessionRow({
        id: 's-shared-1',
        userId: 'other',
        workspaceId: 'ws-1',
        visibility: 'shared',
      }),
      makeSessionRow({
        id: 's-shared-2',
        userId: 'other',
        workspaceId: 'ws-1',
        visibility: 'shared',
      }),
      makeSessionRow({
        id: 's-private',
        userId: 'other',
        workspaceId: 'ws-1',
        visibility: 'private',
      }),
      // biome-ignore lint/suspicious/noExplicitAny: partial session row doubles
    ] as any);
    mockResolveGrant.mockImplementation(async (_access, session) =>
      session.visibility === 'shared' ? 'shared' : 'manage',
    );

    const rows = await listRecentSessionsAction({ limit: 30 });

    const byId = new Map(rows.map((r) => [r.id, r]));
    // Own rows are never manage-only and skip grant resolution entirely.
    expect(byId.get('s-own')).toMatchObject({
      manageOnly: false,
      isOwn: true,
    });
    // Readable ('shared' grant) rows stay clickable.
    expect(byId.get('s-shared-1')?.manageOnly).toBe(false);
    expect(byId.get('s-shared-2')?.manageOnly).toBe(false);
    // A 'manage' grant (not readable) renders as a lock.
    expect(byId.get('s-private')?.manageOnly).toBe(true);
    // Grant resolution is memoized per (workspaceId, visibility): two
    // shared rows in ws-1 cost one resolution, plus one for the private
    // row.
    expect(mockResolveGrant).toHaveBeenCalledTimes(2);
  });
});
