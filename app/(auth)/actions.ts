'use server';

import {
  AUTH_COOKIE_NAME,
  AUTH_TTL_SECONDS,
  getAuthCookieOptions,
  getExpiredAuthCookieOptions,
} from '@/lib/auth';
import { validateCredentials } from '@/lib/auth/credentials';
import { createAuthToken } from '@/lib/auth/session';
import { seedInitialUser, userCount } from '@/lib/core/db/users';
import { cookies } from 'next/headers';

function normalizeRedirectTo(input: string | null | undefined): string {
  if (!input) {
    return '/';
  }

  if (!input.startsWith('/') || input.startsWith('//')) {
    return '/';
  }

  if (input.startsWith('/login')) {
    return '/';
  }

  return input;
}

export async function loginAction(input: {
  username: string;
  password: string;
  redirectTo?: string;
}) {
  const username = input.username.trim();
  const password = input.password;

  if (!username || !password) {
    return {
      ok: false as const,
      error: 'Username and password are required.',
    };
  }

  // Seed initial user from env vars if no users exist yet
  const count = await userCount();
  if (count === 0) {
    await seedInitialUser();
  }

  const user = await validateCredentials({ username, password });
  if (!user) {
    return {
      ok: false as const,
      error: 'Invalid username or password.',
    };
  }

  const token = await createAuthToken(user.id, user.username);
  const cookieStore = await cookies();
  cookieStore.set(
    AUTH_COOKIE_NAME,
    token,
    getAuthCookieOptions(Date.now() + AUTH_TTL_SECONDS * 1000),
  );

  return {
    ok: true as const,
    redirectTo: normalizeRedirectTo(input.redirectTo),
  };
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE_NAME, '', getExpiredAuthCookieOptions());
  return { ok: true as const };
}
