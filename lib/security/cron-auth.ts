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
 * of leaving the endpoint open); when set but the request's secret is
 * wrong/missing, the route returns 401. The two cases MUST stay
 * distinguishable so operators can tell "I forgot to configure it" from
 * "someone is probing the endpoint".
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * A narrow request shape that exposes only the headers a cron auth check
 * reads. Widening the parameter from `NextRequest` to this interface lets
 * callers pass a native `Request` without the `as never` cast the type
 * mismatch used to force.
 */
interface RequestLike {
  headers: {
    get(name: string): string | null;
  };
}

/**
 * Why a cron auth check failed (or was skipped). `valid` and `reason` are
 * both returned so callers can map the failure to the right status code
 * without re-deriving it: `unconfigured` → 503, anything else → 401.
 */
export type CronSecretResult =
  | { valid: true }
  | { valid: false; reason: 'unconfigured' | 'missing' | 'invalid' };

/**
 * Verify the request carries a valid CRON_SECRET.
 *
 * Accepts the secret in either `x-api-key` or `Authorization: Bearer ...`,
 * matching the AGENTD_API_KEY convention so operators reuse mental model.
 *
 * @returns `{ valid: true }` when a valid secret was presented. Otherwise
 *          `{ valid: false, reason }` where reason is:
 *            - `unconfigured` — CRON_SECRET is not set at all (caller
 *              should return 503 so misconfiguration fails closed).
 *            - `missing`      — no secret header on the request (401).
 *            - `invalid`      — secret present but wrong (401).
 */
export function checkCronSecret(request: RequestLike): CronSecretResult {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return { valid: false, reason: 'unconfigured' };
  }

  const provided =
    request.headers.get('x-api-key') ||
    (request.headers.get('authorization')?.startsWith('Bearer ')
      ? request.headers.get('authorization')?.slice('Bearer '.length)
      : '');

  if (!provided) return { valid: false, reason: 'missing' };

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
      return { valid: true };
    }
  }
  return { valid: false, reason: 'invalid' };
}

/**
 * Back-compat boolean wrapper around {@link checkCronSecret}.
 *
 * Returns `true` only when the secret is valid; `false` for every other
 * case (including unconfigured). Prefer calling `checkCronSecret` in new
 * route handlers so the 503-vs-401 distinction is preserved. Accepts a
 * plain `Request` (or anything header-bearing) — the implementation only
 * reads `headers.get()`.
 */
export function hasValidCronSecret(request: RequestLike): boolean {
  return checkCronSecret(request).valid;
}
