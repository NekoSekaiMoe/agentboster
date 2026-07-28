/**
 * Shared auth helper for external cron-triggered routes.
 *
 * `/api/cron/*` routes are bypassed by middleware (see middleware.ts
 * `isAlwaysBypassPath`) because the platform scheduler is not a logged-in
 * user. Each route verifies a `CRON_SECRET` instead — constant-time, with
 * the same comma-separated rotation support as `AGENTD_API_KEY`.
 *
 * Set `CRON_SECRET` in the environment to enable cron routes. When unset,
 * every cron route returns 503 (so misconfiguration fails closed instead
 * of leaving the endpoint open).
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Verify the request carries a valid CRON_SECRET.
 *
 * Accepts the secret in either `x-api-key` or `Authorization: Bearer ...`,
 * matching the AGENTD_API_KEY convention so operators reuse mental model.
 *
 * @returns `true` when a valid secret was presented, `false` otherwise
 *          (including when CRON_SECRET is not configured).
 */
export function hasValidCronSecret(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return false;
  }

  const provided =
    request.headers.get('x-api-key') ||
    (request.headers.get('authorization')?.startsWith('Bearer ')
      ? request.headers.get('authorization')?.slice('Bearer '.length)
      : '');

  if (!provided) return false;

  // CRON_SECRET supports a comma-separated list for key rotation, same
  // semantics as AGENTD_API_KEY.
  const candidates = expected
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    const a = Buffer.from(provided);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}
