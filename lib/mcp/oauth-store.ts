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
} from '@/lib/vault';

const KEY_PREFIX = 'mcp:oauth:';

export const OAUTH_TOKEN_TTL_BUFFER_MS = 60_000; // treat tokens as expired 60s early

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

export function buildOAuthVaultKey(serverName: string): string {
  // Vault key charset is [a-zA-Z0-9_.:-], so the serverName itself must
  // be sanitized. We allow the same charset as vault keys for server
  // names — anything outside is rejected at the config-schema level
  // (mcpRemotesServersConfigSchema uses z.record(z.string(), ...), but
  // the key-edit UI clamps to alnum + dash anyway).
  const safe = serverName.replace(/[^a-zA-Z0-9_.:-]/g, '-');
  return `${KEY_PREFIX}${safe}`;
}

export async function storeOAuthTokenBundle(params: {
  serverName: string;
  bundle: McpOAuthTokenBundle;
  userId?: string;
}): Promise<string> {
  const vaultKey = buildOAuthVaultKey(params.serverName);
  await upsertVaultEntry({
    key: vaultKey,
    value: JSON.stringify(params.bundle),
    userId: params.userId,
  });
  return vaultKey;
}

export async function readOAuthTokenBundle(
  serverName: string,
): Promise<McpOAuthTokenBundle | null> {
  const entry = await readVaultValue({ key: buildOAuthVaultKey(serverName) });
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
  userId?: string;
}): Promise<boolean> {
  return deleteVaultEntry({
    key: buildOAuthVaultKey(input.serverName),
    userId: input.userId,
  });
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
