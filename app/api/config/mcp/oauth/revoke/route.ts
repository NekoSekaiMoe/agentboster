/**
 * Disconnect an MCP server's OAuth connection.
 *
 * POST /api/config/mcp/oauth/revoke
 *   body: { serverName: string }
 *
 * Two-phase cleanup:
 *   1. If the server config has a `revokeUrl` (RFC 7009), POST both the
 *      refresh_token and the access_token there so the provider-side
 *      credentials stop working. Best-effort — network failures and
 *      404/405 (server doesn't implement RFC 7009) are swallowed and
 *      reported but don't block the local cleanup.
 *   2. Delete the encrypted token bundle from the Vault and clear the
 *      `vaultKey` pointer in AppConfig.
 *
 * Order matters: revoke-at-provider FIRST so that even if the local
 * Vault delete fails partway, the credentials are already dead upstream
 * and can't be abused from any cached copy of the bundle.
 *
 * Auth: admin-only.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { createLogger } from '@/lib/utils/logger';
import { getConfig, setConfig } from '@/lib/core/kv/config';
import {
  readOAuthTokenBundle,
  deleteOAuthTokenBundle,
} from '@/lib/mcp/oauth-store';
import { revokeOAuthTokensAtProvider } from '@/lib/mcp/oauth-flow';
import { appConfigSchema } from '@/types/config';
import { cookies } from 'next/headers';
import { z } from 'zod';

const logger = createLogger('api.config.mcp.oauth.revoke');

const requestSchema = z.object({
  serverName: z.string().min(1).max(64),
});

export async function POST(request: Request) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAdminAccess>>;
  try {
    access = await requireAdminAccess(cookieStore);
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error
        ? (error as { status: number }).status
        : 401;
    return Response.json(
      { success: false, error: status === 403 ? 'Forbidden' : 'Unauthorized' },
      { status },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { success: false, error: 'Invalid request' },
      { status: 400 },
    );
  }
  const { serverName } = parsed.data;

  // Load config + current bundle once. We need both to drive the
  // provider-side revocation before mutating anything locally.
  const config = await getConfig();
  const oauth = config.mcp?.[serverName]?.auth?.oauth;
  const bundle = await readOAuthTokenBundle({
    serverName,
    vaultKey: oauth?.vaultKey,
  });

  // Phase 1 — best-effort provider-side revocation. Only attempt if the
  // user has configured a revokeUrl AND we have a bundle to revoke from.
  let providerRevocation: { ok: boolean; error?: string } | undefined;
  if (oauth?.revokeUrl && bundle) {
    providerRevocation = await revokeOAuthTokensAtProvider({
      oauth: { clientId: oauth.clientId, revokeUrl: oauth.revokeUrl },
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
    });
    if (!providerRevocation.ok) {
      logger.warn('mcp_oauth_provider_revoke_partial_failure', {
        serverName,
        error: providerRevocation.error,
      });
      // Don't abort: the local Vault delete still needs to happen so the
      // operator's intent ("disconnect") is honored even if the provider
      // is being weird. Surface the error in the response.
    }
  }

  // Phase 2 — local cleanup.
  const wasDeleted = await deleteOAuthTokenBundle({
    serverName,
    vaultKey: oauth?.vaultKey,
    userId: access.session.userId,
  });

  if (oauth?.vaultKey) {
    delete oauth.vaultKey;
    await setConfig(appConfigSchema.parse(config));
  }

  return Response.json({
    success: true,
    data: {
      serverName,
      wasDeleted,
      clearedConfig: Boolean(oauth),
      providerRevocation: providerRevocation
        ? {
            attempted: true,
            ok: providerRevocation.ok,
            ...(providerRevocation.error
              ? { error: providerRevocation.error }
              : {}),
          }
        : { attempted: false, ok: true },
    },
  });
}
