/**
 * L2 decision link signer/verifier.
 *
 * Used by the URL-button path: when an IM adapter cannot render native
 * callback buttons (QQ has no per-bot button permission; future cases
 * may include SMS / email), the L2 decision prompt ships a markdown
 * link per action instead. The link points at a public, unauthenticated
 * route (`/api/l2/<decisionId>/<action>`) whose only credential is the
 * `t` (expiry epoch seconds) and `s` (HMAC) query params produced here.
 *
 * Threat model & invariants:
 *   - IM users may not have a web account, so the link cannot rely on
 *     the session cookie middleware.
 *   - The HMAC is SHA-256 over `<decisionId>:<action>:<expires>`,
 *     keyed by AUTH_SECRET (the same secret already used for bot
 *     webhook path auth and the login cookie). Forging requires
 *     AUTH_SECRET.
 *   - `expires` bounds the link's validity. We default to 1h — long
 *     enough for the user to notice the IM notification and tap, short
 *     enough that a leaked link (chat history, screenshot) decays.
 *   - Replay: a clicked link is processed exactly once.
 *     `processL2Decision` already dedupes via the notification
 *     manager's `isDecisionProcessed` check, so even if the URL is
 *     opened twice the second hit returns "Already processed." No
 *     separate replay journal is needed here.
 *   - The link carries no secret beyond the HMAC; leaking it is
 *     equivalent to letting someone press the L2 button on the user's
 *     behalf for the lifetime of `expires`. That is the same risk as
 *     any other signed-URL flow (password reset, email verify).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const ALGO = 'sha256';

/** Default link lifetime in seconds (1 hour). */
export const DEFAULT_L2_LINK_TTL_SECONDS = 60 * 60;

/**
 * Sign an L2 decision link.
 *
 * Returns query-string-ready `t=<expires>&s=<hex>` (already
 * URL-component-safe). Caller appends as `?${params}` to the route.
 */
export function signL2Link(input: {
  decisionId: string;
  action: string;
  ttlSeconds?: number;
}): { expires: number; signature: string; params: string } {
  const ttl =
    input.ttlSeconds && input.ttlSeconds > 0
      ? input.ttlSeconds
      : DEFAULT_L2_LINK_TTL_SECONDS;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = computeSignature(input.decisionId, input.action, expires);
  const params = `t=${expires}&s=${signature}`;
  return { expires, signature, params };
}

/**
 * Verify an L2 decision link's HMAC and expiry.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` on any
 * failure (missing params, wrong signature, expired). Constant-time
 * comparison guards against timing attacks on the signature.
 */
export function verifyL2Link(input: {
  decisionId: string;
  action: string;
  expiresParam: string | null | undefined;
  signatureParam: string | null | undefined;
}):
  | { ok: true; expires: number }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' } {
  const { decisionId, action, expiresParam, signatureParam } = input;
  if (!expiresParam || !signatureParam) {
    return { ok: false, reason: 'missing' };
  }
  const expires = Number.parseInt(expiresParam, 10);
  if (!Number.isFinite(expires) || expires <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  // Reject expired links before the HMAC check so we don't leak validity
  // of old signatures via timing.
  if (Math.floor(Date.now() / 1000) >= expires) {
    return { ok: false, reason: 'expired' };
  }
  const expected = computeSignature(decisionId, action, expires);
  const given = signatureParam;
  if (expected.length !== given.length) {
    return { ok: false, reason: 'invalid' };
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, expires };
}

function computeSignature(
  decisionId: string,
  action: string,
  expires: number,
): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required to sign/verify L2 links. Set it in your environment.',
    );
  }
  const message = `${decisionId}:${action}:${expires}`;
  return createHmac(ALGO, secret).update(message).digest('hex');
}
