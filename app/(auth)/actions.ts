'use server';

import {
  AUTH_COOKIE_NAME,
  AUTH_TTL_SECONDS,
  getAuthConfigStatus,
  getAuthCookieOptions,
  getExpiredAuthCookieOptions,
  validateCredentials,
} from '@/lib/auth';
import { createAuthToken } from '@/lib/auth/session';
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
  const authConfig = getAuthConfigStatus();
  if (!authConfig.isConfigured) {
    return {
      ok: false as const,
      error:
        'Authentication is not configured. Set AUTH_SECRET, USERNAME, and PASSWORD in .env.local or .env, then restart the app.',
    };
  }

  const username = input.username.trim();
  const password = input.password;

  if (!username || !password) {
    return {
      ok: false as const,
      error: 'Username and password are required.',
    };
  }

  const isValid = validateCredentials({ username, password });
  if (!isValid) {
    return {
      ok: false as const,
      error: 'Invalid username or password.',
    };
  }

  const token = await createAuthToken(username);
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
