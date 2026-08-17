import { z } from 'zod';

import { parseWithFallback } from '@/lib/core/api/schema';

/**
 * Client fetcher for GET /api/auth/me — the lightweight identity probe
 * used by chat chrome (session list, workspace switcher, sidebar) that
 * renders OUTSIDE the /config ConfigProvider subtree.
 *
 * Lenient by design (see parseWithFallback): an older backend that omits
 * `username`/`isAdmin` still parses; a 401 (logged out / session expired)
 * yields the null identity rather than throwing so callers can keep
 * rendering a signed-out shell.
 */
const identityResponseSchema = z.object({
  userId: z.string(),
  username: z.string().optional(),
  isAdmin: z.boolean().optional(),
});

export interface Identity {
  userId: string;
  username?: string;
  isAdmin: boolean;
}

export async function fetchIdentity(): Promise<Identity | null> {
  const res = await fetch('/api/auth/me', { cache: 'no-store' });
  if (!res.ok) return null;
  const parsed = parseWithFallback(
    await res.json().catch(() => ({})),
    identityResponseSchema,
    null as z.infer<typeof identityResponseSchema> | null,
    { endpoint: 'GET /api/auth/me' },
  );
  if (!parsed) return null;
  return {
    userId: parsed.userId,
    username: parsed.username,
    isAdmin: parsed.isAdmin ?? false,
  };
}
