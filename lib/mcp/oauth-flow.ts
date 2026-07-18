/**
 * OAuth 2.0 Authorization Code Flow with PKCE (RFC 7636) for MCP servers.
 *
 * Many hosted MCP servers (GitHub, Linear, Notion, …) require OAuth for
 * per-user authorization. This module implements the client side of the
 * Authorization Code + PKCE flow, shared by the route handlers under
 * app/api/config/mcp/oauth/.
 *
 * The flow:
 *   1. User clicks "Connect" in the MCP config UI.
 *   2. /api/config/mcp/oauth/authorize generates a code_verifier +
 *      code_challenge (S256) and a random state, stores them in a
 *      short-lived signed cookie, and redirects to the server's
 *      authorize URL.
 *   3. User authorizes on the server; server redirects back to
 *      /api/config/mcp/oauth/callback?code=...&state=...
 *   4. The callback validates state, exchanges code+verifier for tokens
 *      at the server's token URL, and stores the encrypted token bundle
 *      in the Vault.
 *   5. The UI polls /api/config/mcp/oauth/status to see "Connected".
 *
 * We use cookies (not KV) for the intermediate PKCE+state because:
 *   - It's per-browser, so a second admin starting a flow can't clobber
 *     the first one's verifier (KV would require a per-flow key).
 *   - It's stateless from the server's POV — no reaper, no TTL.
 *   - It's signed with AUTH_SECRET via the existing session cookie
 *     helper machinery (we reuse cookie signing from lib/auth/session).
 *
 * If the user has cookies disabled the flow simply fails with a clear
 * error — that's acceptable for an admin-only config flow.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpOAuthConfig } from '@/types/config/mcp';

export const PKCE_VERIFIER_BYTES = 32;
export const STATE_BYTES = 16;
const PKCE_COOKIE_NAME = 'mcp_oauth_pkce';
const STATE_COOKIE_NAME = 'mcp_oauth_state';
const SERVER_COOKIE_NAME = 'mcp_oauth_server';
const RETURN_COOKIE_NAME = 'mcp_oauth_return';

/** RFC 7636: base64url, no padding. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(PKCE_VERIFIER_BYTES));
}

export function computeCodeChallenge(verifier: string): string {
  // Plain SHA-256 per RFC 7636 §4.2 (S256 method).
  return base64url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(STATE_BYTES));
}

/**
 * Build the absolute redirect URI for a given server name.
 *
 * Mounted at /api/config/mcp/oauth/callback — one callback handler
 * dispatches by the `server` cookie. Some MCP servers (notably GitHub's)
 * register a single redirect URI per OAuth app, so we don't include the
 * server name in the URL path.
 */
export function buildRedirectUri(params: { publicAppUrl: string }): string {
  const base = params.publicAppUrl.replace(/\/$/, '');
  return `${base}/api/config/mcp/oauth/callback`;
}

export function buildAuthorizeUrl(params: {
  oauth: McpOAuthConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(params.oauth.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.oauth.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.oauth.scope) {
    url.searchParams.set('scope', params.oauth.scope);
  }
  if (params.oauth.resource) {
    url.searchParams.set('resource', params.oauth.resource);
  }
  return url.toString();
}

/**
 * Exchange an authorization code for a token bundle.
 *
 * Per RFC 6749 §4.1.3 + RFC 7636 §4.5. The request body is form-encoded
 * (most MCP servers reject JSON here — GitHub included).
 */
export async function exchangeCodeForTokens(params: {
  oauth: McpOAuthConfig;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.oauth.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.oauth.resource) {
    body.set('resource', params.oauth.resource);
  }

  const response = await fetch(params.oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed: HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  // Try JSON first; fall back to form-encoded (RFC 6749 §5.1 mandates JSON,
  // but some servers — notably older GitHub — return form-encoded).
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = Object.fromEntries(new URLSearchParams(text)) as Record<
      string,
      unknown
    >;
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(
      `OAuth token exchange succeeded but no access_token in response: ${text.slice(0, 200)}`,
    );
  }

  const expiresInRaw = payload.expires_in;
  const expiresIn =
    typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw)
      ? expiresInRaw
      : typeof expiresInRaw === 'string' && /^\d+$/.test(expiresInRaw)
        ? Number.parseInt(expiresInRaw, 10)
        : undefined;

  return {
    accessToken,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    tokenType:
      typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
  };
}

/**
 * Refresh an expired access_token using the refresh_token grant.
 * Returns null if the server didn't issue a refresh_token.
 */
export async function refreshAccessToken(params: {
  oauth: McpOAuthConfig;
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
} | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.oauth.clientId,
  });
  if (params.oauth.resource) {
    body.set('resource', params.oauth.resource);
  }

  const response = await fetch(params.oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OAuth refresh failed: HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = Object.fromEntries(new URLSearchParams(text)) as Record<
      string,
      unknown
    >;
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    return null;
  }

  const expiresInRaw = payload.expires_in;
  const expiresIn =
    typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw)
      ? expiresInRaw
      : typeof expiresInRaw === 'string' && /^\d+$/.test(expiresInRaw)
        ? Number.parseInt(expiresInRaw, 10)
        : undefined;

  return {
    accessToken,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : params.refreshToken, // many servers don't return new refresh
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    tokenType:
      typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
  };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Revoke tokens at the provider via RFC 7009.
 *
 * POSTs both access_token and refresh_token (if present) with the
 * `token_type_hint` parameter. Per RFC 7009 §2.1 the endpoint is
 * OPTIONAL — servers that don't implement it return 404/405 and we
 * swallow the error (the local Vault delete still happens; the
 * provider-side token just lives until natural expiry).
 *
 * Per RFC 7009 §2.1: "The client requests the revocation of a
 * particular token by making an HTTP POST request to the token
 * revocation endpoint URL. ... The client MUST include its
 * `client_id` if the revocation endpoint is not protected by
 * another authentication method." We always send `client_id` since
 * we don't have client_credentials (Authorization Code + PKCE only).
 *
 * Returns: aggregated result — if BOTH revocations succeeded (or one
 * succeeded and the other was absent), returns { ok: true }. Returns
 * { ok: false, error } only when the server actively rejected a
 * revocation call (not on network errors, which we treat as best-effort).
 */
export async function revokeOAuthTokensAtProvider(params: {
  oauth: Pick<
    import('@/types/config/mcp').McpOAuthConfig,
    'clientId' | 'revokeUrl'
  >;
  accessToken?: string;
  refreshToken?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { oauth, accessToken, refreshToken } = params;
  if (!oauth.revokeUrl) {
    return { ok: true };
  }

  const tokens = [
    { token: refreshToken, hint: 'refresh_token' as const },
    { token: accessToken, hint: 'access_token' as const },
  ].filter(
    (t): t is { token: string; hint: 'refresh_token' | 'access_token' } =>
      Boolean(t.token),
  );

  if (tokens.length === 0) {
    return { ok: true };
  }

  const errors: string[] = [];

  // RFC 7009 §2.2: the server SHOULD process revocations serially to
  // invalidate refresh_token before access_token. We do this sequentially.
  for (const { token, hint } of tokens) {
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: oauth.clientId,
    });

    try {
      const response = await fetch(oauth.revokeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      // RFC 7009 §2.2: "The authorization server responds with HTTP
      // status code 200 if the token has been revoked successfully or
      // if the client submitted an invalid token." So 200 = success,
      // anything else is unexpected.
      //
      // 404/405 means the server doesn't implement RFC 7009 — treat
      // as "best effort, move on" rather than a hard failure.
      if (response.status === 404 || response.status === 405) {
        // server doesn't implement revocation; skip silently.
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        errors.push(
          `${hint} revoke failed: HTTP ${response.status}: ${text.slice(0, 200)}`,
        );
      }
    } catch (error) {
      // Network error — provider unreachable. We don't fail the whole
      // revoke flow because the Vault delete already happened locally;
      // the provider-side token will expire naturally.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${hint} revoke network error: ${message}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }
  return { ok: true };
}

export const OAUTH_COOKIE_NAMES = {
  pkce: PKCE_COOKIE_NAME,
  state: STATE_COOKIE_NAME,
  server: SERVER_COOKIE_NAME,
  returnTo: RETURN_COOKIE_NAME,
} as const;
