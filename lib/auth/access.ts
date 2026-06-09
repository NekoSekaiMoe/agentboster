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

export async function requireAuthAccess(
  cookieStore: Pick<RequestCookies, 'get'>,
): Promise<AuthAccess> {
  const session = await readAuthSessionFromCookies(cookieStore);

  if (!session) {
    throw new Error('Unauthorized');
  }

  const user = await getUserById(session.userId);
  if (!user) {
    throw new Error('Unauthorized');
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
    throw new Error('Forbidden');
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
    throw new Error('Forbidden');
  }
}
