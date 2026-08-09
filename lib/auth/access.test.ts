/**
 * Tests for the pure authorization primitives in lib/auth/access.ts.
 *
 * `canAccessOwnedResource`, `assertCanAccessOwnedResource` and the
 * `AuthError` class are pure (no DB). The `requireAuthAccess` /
 * `requireAdminAccess` helpers go through readAuthSessionFromCookies +
 * getUserById (DB) and are intentionally NOT covered here — they belong
 * in an integration test.
 *
 * The regression these tests guard against: AuthError must carry an
 * explicit status (401 vs 403) so callers do not need a blanket
 * `catch → 401` that would mislabel 5xx failures as "unauthorized".
 */

import { describe, expect, it } from 'vitest';
import {
  type AuthAccess,
  AuthError,
  assertCanAccessOwnedResource,
  canAccessOwnedResource,
} from './access';

describe('AuthError', () => {
  it('carries the 401 status for Unauthorized', () => {
    const err = new AuthError('Unauthorized', 401);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
    expect(err.name).toBe('AuthError');
    expect(err instanceof Error).toBe(true);
  });

  it('carries the 403 status for Forbidden', () => {
    const err = new AuthError('Forbidden', 403);
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
  });
});

describe('canAccessOwnedResource', () => {
  const adminAccess = {
    isAdmin: true,
    session: { userId: 'admin-1' },
  } as Pick<AuthAccess, 'isAdmin' | 'session'>;
  const userAccess = {
    isAdmin: false,
    session: { userId: 'user-1' },
  } as Pick<AuthAccess, 'isAdmin' | 'session'>;

  it('allows admin access to any resource', () => {
    expect(canAccessOwnedResource(adminAccess, 'someone-else')).toBe(true);
  });

  it('allows a user to access their own resource', () => {
    expect(canAccessOwnedResource(userAccess, 'user-1')).toBe(true);
  });

  it('denies a non-admin access to another user resource', () => {
    expect(canAccessOwnedResource(userAccess, 'user-2')).toBe(false);
  });

  it('denies non-admin access when owner is null', () => {
    expect(canAccessOwnedResource(userAccess, null)).toBe(false);
  });

  it('denies non-admin access when owner is undefined', () => {
    expect(canAccessOwnedResource(userAccess, undefined)).toBe(false);
  });

  it('admin can access resources with a null owner', () => {
    expect(canAccessOwnedResource(adminAccess, null)).toBe(true);
  });
});

describe('assertCanAccessOwnedResource', () => {
  const userAccess = {
    isAdmin: false,
    session: { userId: 'user-1' },
  } as Pick<AuthAccess, 'isAdmin' | 'session'>;

  it('does not throw when access is allowed', () => {
    expect(() =>
      assertCanAccessOwnedResource(userAccess, 'user-1'),
    ).not.toThrow();
  });

  it('throws AuthError with status 403 when access is denied', () => {
    try {
      assertCanAccessOwnedResource(userAccess, 'user-2');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
      expect((err as AuthError).message).toBe('Forbidden');
    }
  });
});
