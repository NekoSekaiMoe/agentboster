/**
 * Vault-backed storage for MCP OAuth token bundles.
 *
 * Tokens are NEVER stored in AppConfig (which is a global KV document read
 * by every config consumer, including non-admins via the read-only
 * /api/config route). They live in the Vault as a JSON bundle under the
 * key `mcp:oauth:<serverName>`.
 *
 * The bundle shape is an internal contract between this module and the
 * OAuth callback route — keep it stable, and keep it minimal (refresh
 * rotation will rewrite the whole bundle).
 */

import {
  upsertVaultEntry,
  readVaultValue,
  deleteVaultEntry,
} from '@/lib/extra/vault';

const KEY_PREFIX = 'mcp:oauth:';

export const OAUTH_TOKEN_TTL_BUFFER_MS = 60_000; // treat tokens as expired 60s early

/**
 * Vault key charset — must match `validateVaultKey` in lib/extra/vault/index.ts.
 * Used to reject (not silently rewrite) server names that would otherwise
 * collide after sanitization (e.g. `a/b` and `a.b` both mapping to `a-b`).
 */
const VAULT_KEY_CHARSET = /^[a-zA-Z0-9_.:-]{1,128}$/;

/**
 * The encrypted bundle stored under `mcp:oauth:<serverName>`.
 *
 * Field naming matches RFC 6749:
 *  - access_token  : bearer credential sent in `Authorization` header
 *  - refresh_token : optional; used to obtain a new access_token
 *  - expires_at    : epoch ms when access_token expires (from `expires_in`)
 *  - token_type    : usually "Bearer"
 *  - scope         : space-separated scopes the server actually granted
 */
export type McpOAuthTokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string;
  scope?: string;
};

/**
 * Build the canonical Vault key for a server name.
 *
 * Server names must already match the Vault key charset (`[a-zA-Z0-9_.:-]`).
 * We deliberately DO NOT sanitize here — silently rewriting disallowed
 * characters to `-` caused collision bugs (e.g. `a/b` and `a.b` both
 * producing `a-b`). Callers must validate the name at the config-schema
 * boundary; this function throws on invalid input so the bug surfaces
 * loudly instead of corrupting a different server's credential.
 */
export function buildOAuthVaultKey(serverName: string): string {
  if (!VAULT_KEY_CHARSET.test(serverName)) {
    throw new Error(
      `Invalid MCP server name "${serverName}": must be 1-128 chars and contain only [a-zA-Z0-9_.:-].`,
    );
  }
  return `${KEY_PREFIX}${serverName}`;
}

export async function storeOAuthTokenBundle(params: {
  serverName: string;
  bundle: McpOAuthTokenBundle;
  userId?: string;
  /**
   * Explicit vault key to write under. When omitted, the key is derived
   * from `serverName` via `buildOAuthVaultKey`.
   *
   * Passing an explicit key is required when the caller located the
   * bundle via an `oauth.vaultKey` pointer that does NOT match the
   * canonical `mcp:oauth:<serverName>` form — most notably after a
   * server rename, where reading through the old pointer must write
   * back to the SAME location or the next read will miss the rotated
   * refresh_token and replay the now-consumed one.
   */
  vaultKey?: string;
}): Promise<string> {
  const vaultKey = params.vaultKey ?? buildOAuthVaultKey(params.serverName);
  await upsertVaultEntry({
    key: vaultKey,
    value: JSON.stringify(params.bundle),
    userId: params.userId,
  });
  return vaultKey;
}

/**
 * Read the stored bundle. Accepts either an explicit `vaultKey` (the
 * canonical locator, set in AppConfig after a successful OAuth flow) or
 * a `serverName` (legacy fallback — used only when an older config lacks
 * `vaultKey`, e.g. for servers connected before this field existed).
 *
 * Preferring `vaultKey` keeps the bundle reachable after a server rename
 * — the pointer travels with the config row instead of being re-derived
 * from a name that no longer exists.
 */
export async function readOAuthTokenBundle(params: {
  serverName: string;
  vaultKey?: string;
}): Promise<McpOAuthTokenBundle | null> {
  const key = params.vaultKey ?? buildOAuthVaultKey(params.serverName);
  const entry = await readVaultValue({ key });
  if (!entry) return null;
  try {
    return JSON.parse(entry.value) as McpOAuthTokenBundle;
  } catch {
    return null;
  }
}

/**
 * Wipe the encrypted token bundle from the vault. Returns true if
 * something was deleted. The caller (revoke route) is also responsible
 * for clearing the `vaultKey` field in AppConfig so a stale pointer
 * doesn't linger after the credential is gone.
 */
export async function deleteOAuthTokenBundle(input: {
  serverName: string;
  vaultKey?: string;
  userId?: string;
}): Promise<boolean> {
  const key = input.vaultKey ?? buildOAuthVaultKey(input.serverName);
  return deleteVaultEntry({ key, userId: input.userId });
}

/**
 * Whether the stored access token can still be used without a refresh.
 * Returns false if no bundle, no accessToken, or already expired.
 */
export function isTokenFresh(bundle: McpOAuthTokenBundle | null): boolean {
  if (!bundle?.accessToken) return false;
  if (!bundle.expiresAt) return true; // no expiry → assume fresh
  return bundle.expiresAt - Date.now() > OAUTH_TOKEN_TTL_BUFFER_MS;
}
