import { readAuthSessionFromCookies } from '@/lib/auth/session';
import {
  type StoredUser,
  getUserById,
  hasAdminRole,
} from '@/lib/core/db/users';
import type { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies';

export type AuthAccess = {
  session: NonNullable<Awaited<ReturnType<typeof readAuthSessionFromCookies>>>;
  user: StoredUser;
  isAdmin: boolean;
};

/**
 * Error thrown by the access helpers for the two authorization failure
 * modes (missing/invalid session → 401, insufficient role → 403).
 *
 * It carries an explicit `status` so callers can map an auth failure to the
 * right HTTP code WITHOUT a blanket `catch → 401`, which would also swallow
 * unrelated failures (a DB error inside getUserById, a missing AUTH_SECRET)
 * and mislabel a 5xx as "unauthorized".
 *
 * The `message` is kept as the bare 'Unauthorized' / 'Forbidden' string for
 * backward compatibility with the several routes that still branch on
 * `error.message === 'Unauthorized'` to pick a status code.
 */
export class AuthError extends Error {
  readonly status: number;

  constructor(message: 'Unauthorized' | 'Forbidden', status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export async function requireAuthAccess(
  cookieStore: Pick<RequestCookies, 'get'>,
): Promise<AuthAccess> {
  const session = await readAuthSessionFromCookies(cookieStore);

  if (!session) {
    throw new AuthError('Unauthorized', 401);
  }

  const user = await getUserById(session.userId);
  if (!user) {
    throw new AuthError('Unauthorized', 401);
  }

  return {
    session,
    user,
    isAdmin: hasAdminRole(user.roles),
  };
}

export async function requireAdminAccess(
  cookieStore: Pick<RequestCookies, 'get'>,
): Promise<AuthAccess> {
  const access = await requireAuthAccess(cookieStore);

  if (!access.isAdmin) {
    throw new AuthError('Forbidden', 403);
  }

  return access;
}

export function canAccessOwnedResource(
  access: Pick<AuthAccess, 'isAdmin' | 'session'>,
  ownerUserId: string | null | undefined,
) {
  return access.isAdmin || ownerUserId === access.session.userId;
}

export function assertCanAccessOwnedResource(
  access: Pick<AuthAccess, 'isAdmin' | 'session'>,
  ownerUserId: string | null | undefined,
) {
  if (!canAccessOwnedResource(access, ownerUserId)) {
    throw new AuthError('Forbidden', 403);
  }
}
