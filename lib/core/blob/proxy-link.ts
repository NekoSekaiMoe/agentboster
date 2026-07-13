/**
 * Blob proxy link signer/verifier (self-hosted deployments only).
 *
 * On Vercel, `put()` returns a Vercel Blob URL that the LLM/browser can fetch
 * directly. Self-hosted S3/MinIO has no such public URL, so instead of handing
 * out (long-lived, hard-to-rotate) S3 presigned URLs, the S3 backend returns a
 * URL pointing at our own proxy route:
 *
 *   ${PUBLIC_APP_URL}/api/blob/<blobPath>?t=<expires>&s=<hmac>
 *
 * The proxy route (`app/api/blob/[...path]/route.ts`) streams the object via
 * the same `getBlob()` path the authenticated download route uses. Because the
 * proxy is reachable without a session cookie (LLM providers and browsers have
 * no cookie), the `t`/`s` query params ARE the credential — mirroring the
 * existing signed-link pattern in `lib/security/l2-link.ts`.
 *
 * Threat model (same shape as l2-link):
 *   - HMAC-SHA256 over `<blobPath>:<expires>`, keyed by AUTH_SECRET. Forging a
 *     URL for an arbitrary key requires AUTH_SECRET.
 *   - `expires` bounds validity. Attachments handed to an LLM only need to be
 *     fetchable for the duration of the model call, but the same URL is also
 *     persisted on the chat message and re-rendered in the web UI later, so we
 *     default to a long TTL (30 days) to keep historical previews working.
 *   - A leaked signed URL grants read of that one object until it expires —
 *     the same risk as any signed-URL scheme. Blob paths are not secret; the
 *     signature is what gates access.
 *
 * IMPORTANT: `node:crypto` is imported lazily inside the functions. This module
 * is only ever called from host code (the S3 backend and the proxy route, both
 * Node), but keeping the import dynamic matches the repo-wide rule that any
 * file potentially reachable from the workflow bundle must avoid top-level
 * `node:*` imports (see CLAUDE.md). The blob wrapper is reached via
 * `await import('@/lib/core/blob')` from the sandbox tool, so err on the safe
 * side here too.
 */

const ALGO = 'sha256';

/** Default proxy-URL lifetime in seconds (30 days). */
export const DEFAULT_BLOB_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;

async function computeSignature(
  blobPath: string,
  expires: number,
): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required to sign/verify blob proxy URLs. Set it in your environment.',
    );
  }
  const { createHmac } = await import('node:crypto');
  const message = `${blobPath}:${expires}`;
  return createHmac(ALGO, secret).update(message).digest('hex');
}

/**
 * Sign a blob proxy URL for `blobPath`, returning the fully-formed absolute
 * URL (base + encoded path + `?t=&s=`). `baseUrl` should be the public app
 * origin (from `getPublicAppUrl()`); it is passed in rather than read here so
 * this module stays a pure signer with no deploy-config dependency.
 */
export async function signBlobUrl(input: {
  baseUrl: string;
  blobPath: string;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl =
    input.ttlSeconds && input.ttlSeconds > 0
      ? input.ttlSeconds
      : DEFAULT_BLOB_LINK_TTL_SECONDS;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = await computeSignature(input.blobPath, expires);
  // Encode each path segment but preserve the `/` separators so the proxy
  // route's [...path] catch-all reconstructs the original key.
  const encodedPath = input.blobPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const base = input.baseUrl.replace(/\/+$/, '');
  return `${base}/api/blob/${encodedPath}?t=${expires}&s=${signature}`;
}

/**
 * Verify a blob proxy request's signature and expiry. Returns `{ ok: true }`
 * or `{ ok: false, reason }`. Constant-time comparison on the signature.
 */
export async function verifyBlobUrl(input: {
  blobPath: string;
  expiresParam: string | null | undefined;
  signatureParam: string | null | undefined;
}): Promise<
  | { ok: true; expires: number }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' }
> {
  const { blobPath, expiresParam, signatureParam } = input;
  if (!expiresParam || !signatureParam) {
    return { ok: false, reason: 'missing' };
  }
  const expires = Number.parseInt(expiresParam, 10);
  if (!Number.isFinite(expires) || expires <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  // Reject expired URLs before the HMAC check so we don't leak old-signature
  // validity through timing.
  if (Math.floor(Date.now() / 1000) >= expires) {
    return { ok: false, reason: 'expired' };
  }
  const expected = await computeSignature(blobPath, expires);
  if (expected.length !== signatureParam.length) {
    return { ok: false, reason: 'invalid' };
  }
  const { timingSafeEqual } = await import('node:crypto');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureParam, 'utf8');
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, expires };
}
