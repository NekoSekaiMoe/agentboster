/**
 * Unit tests for the shared-session access gate (lib/chat/session-access.ts).
 *
 * The workspace boundary (resolveWorkspaceAccess) is mocked; the tests
 * assert the GRANT MATRIX: who gets owner / shared / manage / nothing,
 * and which grants may read message content.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/core/db/agentd', () => ({
  resolveWorkspaceAccess: mocks.resolveWorkspaceAccess,
}));

import type { AuthAccess } from '@/lib/auth/access';
import {
  assertCanManageSharedSession,
  assertCanReadSession,
  resolveSessionGrant,
  sessionGrantCanRead,
} from '@/lib/chat/session-access';

function makeAccess(input: {
  userId: string;
  roles?: string[];
  isAdmin?: boolean;
}): AuthAccess {
  return {
    session: { userId: input.userId },
    user: { id: input.userId, roles: input.roles ?? ['user'] },
    isAdmin: input.isAdmin ?? false,
  } as unknown as AuthAccess;
}

const OWNER = makeAccess({ userId: 'u1' });
const MEMBER = makeAccess({ userId: 'u2' });
const ADMIN = makeAccess({ userId: 'u3', roles: ['admin'], isAdmin: true });

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: 'u1',
    workspaceId: null,
    visibility: 'private',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionGrantCanRead', () => {
  it('only owner and shared grants may read content', () => {
    expect(sessionGrantCanRead('owner')).toBe(true);
    expect(sessionGrantCanRead('shared')).toBe(true);
    expect(sessionGrantCanRead('manage')).toBe(false);
  });
});

describe('resolveSessionGrant', () => {
  it('the creator always gets the owner grant (no workspace lookup)', async () => {
    expect(await resolveSessionGrant(OWNER, session())).toBe('owner');
    expect(mocks.resolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('global-scope sessions: member gets nothing, admin gets manage-only', async () => {
    expect(await resolveSessionGrant(MEMBER, session())).toBeNull();
    expect(await resolveSessionGrant(ADMIN, session())).toBe('manage');
  });

  it('shared session in an accessible workspace → shared grant (readable)', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: true,
      canManage: false,
    });
    const target = session({ workspaceId: 'w1', visibility: 'shared' });
    expect(await resolveSessionGrant(MEMBER, target)).toBe('shared');
  });

  it('workspace manager on a shared session keeps read access (shared wins)', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: true,
      canManage: true,
    });
    const target = session({ workspaceId: 'w1', visibility: 'shared' });
    expect(await resolveSessionGrant(MEMBER, target)).toBe('shared');
  });

  it('workspace manager on a PRIVATE session → manage-only (no read)', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: true,
      canManage: true,
    });
    const target = session({ workspaceId: 'w1', visibility: 'private' });
    expect(await resolveSessionGrant(MEMBER, target)).toBe('manage');
    await expect(assertCanReadSession(MEMBER, target)).rejects.toMatchObject({
      name: 'AuthError',
      status: 403,
    });
  });

  it('assertCanManageSharedSession succeeds for a manage grant', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: true,
      canManage: true,
    });
    const target = session({ workspaceId: 'w1', visibility: 'private' });
    await expect(assertCanManageSharedSession(MEMBER, target)).resolves.toBe(
      'manage',
    );
  });

  it('global admin on another user’s SHARED session with an unresolvable workspace → manage, never read', async () => {
    const target = session({
      userId: 'u1',
      workspaceId: 'w1',
      visibility: 'shared',
    });

    // Workspace row missing entirely.
    mocks.resolveWorkspaceAccess.mockResolvedValue(null);
    expect(await resolveSessionGrant(ADMIN, target)).toBe('manage');

    // Workspace resolves but the admin has no access to it.
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: false,
      canManage: false,
    });
    expect(await resolveSessionGrant(ADMIN, target)).toBe('manage');

    // manage is metadata-only: content read stays rejected.
    await expect(assertCanReadSession(ADMIN, target)).rejects.toMatchObject({
      name: 'AuthError',
      status: 403,
    });
  });

  it('plain member on another member’s private session → invisible', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: { id: 'w1' },
      canAccess: true,
      canManage: false,
    });
    const target = session({ workspaceId: 'w1', visibility: 'private' });
    expect(await resolveSessionGrant(MEMBER, target)).toBeNull();
  });

  it('fails closed when the workspace lookup throws', async () => {
    mocks.resolveWorkspaceAccess.mockRejectedValue(new Error('db down'));
    const target = session({ workspaceId: 'w1', visibility: 'shared' });
    expect(await resolveSessionGrant(MEMBER, target)).toBeNull();
  });

  it('missing workspace row: admin still curates (manage), member gets nothing', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(null);
    const target = session({ workspaceId: 'w1' });
    expect(await resolveSessionGrant(ADMIN, target)).toBe('manage');
    expect(await resolveSessionGrant(MEMBER, target)).toBeNull();
  });
});
