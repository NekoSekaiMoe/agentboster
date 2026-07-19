/**
 * OAuth connection status for one MCP server.
 *
 * GET /api/config/mcp/oauth/status?serverName=<name>
 *
 * Returns whether an OAuth token bundle exists in the vault for this
 * server, and whether the access token is currently usable (not
 * expired, or refreshable). Does NOT return the tokens themselves —
 * status is for the UI badge, not for impersonating the user.
 *
 * Auth: admin-only. The existence of a vault entry is itself sensitive
 * (it implies an admin authorized this server), and we don't want a
 * non-admin to enumerate which MCP servers are OAuth-connected.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { getConfig } from '@/lib/core/kv/config';
import { readOAuthTokenBundle, isTokenFresh } from '@/lib/mcp/oauth-store';
import { cookies } from 'next/headers';
import { z } from 'zod';

const querySchema = z.object({
  serverName: z.string().min(1).max(64),
});

export async function GET(request: Request) {
  const cookieStore = await cookies();
  try {
    await requireAdminAccess(cookieStore);
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

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    serverName: url.searchParams.get('serverName') ?? '',
  });
  if (!parsed.success) {
    return Response.json(
      { success: false, error: 'Invalid serverName' },
      { status: 400 },
    );
  }

  const config = await getConfig();
  const oauth = config.mcp?.[parsed.data.serverName]?.auth?.oauth;

  const bundle = await readOAuthTokenBundle({
    serverName: parsed.data.serverName,
    vaultKey: oauth?.vaultKey,
  });
  if (!bundle) {
    return Response.json({
      success: true,
      data: { connected: false, state: 'disconnected' as const },
    });
  }

  const fresh = isTokenFresh(bundle);
  const state = fresh
    ? ('connected' as const)
    : bundle.refreshToken
      ? ('expired_refreshable' as const)
      : ('expired' as const);

  return Response.json({
    success: true,
    data: {
      connected: true,
      state,
      expiresAt: bundle.expiresAt,
      scope: bundle.scope,
      hasRefreshToken: Boolean(bundle.refreshToken),
    },
  });
}
