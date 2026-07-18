/**
 * OAuth Authorization Code + PKCE callback handler.
 *
 * GET /api/config/mcp/oauth/callback?code=...&state=...
 *
 * Validates state against the cookie, exchanges code+verifier for tokens,
 * stores the encrypted bundle in the Vault under `mcp:oauth:<serverName>`,
 * then redirects back to the config UI.
 *
 * Single callback URL serves all MCP servers — the per-server context
 * is carried in the `mcp_oauth_server` cookie set by the authorize
 * route. This is required because some MCP providers (notably GitHub's
 * hosted MCP) register a single redirect URI per OAuth app and don't
 * allow per-server suffixes.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { getConfig, setConfig } from '@/lib/core/kv/config';
import { getPublicAppUrl } from '@/lib/extra/deploy';
import { createLogger } from '@/lib/utils/logger';
import {
  OAUTH_COOKIE_NAMES,
  buildRedirectUri,
  constantTimeEqual,
  exchangeCodeForTokens,
} from '@/lib/mcp/oauth-flow';
import { storeOAuthTokenBundle } from '@/lib/mcp/oauth-store';
import { appConfigSchema } from '@/types/config';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.config.mcp.oauth.callback');

const DEFAULT_RETURN_PATH = '/config/mcp';

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  const returnTo =
    cookieStore.get(OAUTH_COOKIE_NAMES.returnTo)?.value ?? DEFAULT_RETURN_PATH;

  // Clear flow cookies regardless of outcome — they're single-use.
  const clearCookies = () => {
    for (const name of Object.values(OAUTH_COOKIE_NAMES)) {
      cookieStore.delete(name);
    }
  };

  // Server-side error (e.g. user denied consent) — redirect with error.
  if (errorParam) {
    clearCookies();
    return redirectToConfig(returnTo, {
      error: errorParam,
      error_description: errorDescription ?? '',
    });
  }

  if (!code || !state) {
    clearCookies();
    return redirectToConfig(returnTo, {
      error: 'invalid_callback',
      error_description: 'Missing code or state in OAuth callback',
    });
  }

  const verifier = cookieStore.get(OAUTH_COOKIE_NAMES.pkce)?.value;
  const expectedState = cookieStore.get(OAUTH_COOKIE_NAMES.state)?.value;
  const serverName = cookieStore.get(OAUTH_COOKIE_NAMES.server)?.value;

  if (!verifier || !expectedState || !serverName) {
    clearCookies();
    return redirectToConfig(returnTo, {
      error: 'expired_flow',
      error_description:
        'OAuth flow expired or cookies were cleared. Please retry.',
    });
  }

  // Admin check — the callback URL itself isn't session-protected by
  // middleware if the OAuth provider opens it in a new browser context.
  try {
    await requireAdminAccess(cookieStore);
  } catch (error) {
    clearCookies();
    const status =
      error instanceof Error && 'status' in error
        ? (error as { status: number }).status
        : 401;
    return redirectToConfig(returnTo, {
      error: status === 403 ? 'forbidden' : 'unauthorized',
      error_description: 'Admin access required',
    });
  }

  if (!constantTimeEqual(state, expectedState)) {
    clearCookies();
    logger.warn('oauth_state_mismatch', { serverName });
    return redirectToConfig(returnTo, {
      error: 'state_mismatch',
      error_description: 'OAuth state validation failed',
    });
  }

  // Load the server's OAuth config. getConfig is React cache()-wrapped
  // for per-request dedup; we only need one read here.
  const config = await getConfig();
  const serverConfig = config.mcp?.[serverName];
  if (!serverConfig?.auth?.oauth) {
    clearCookies();
    return redirectToConfig(returnTo, {
      error: 'config_missing',
      error_description: `Server "${serverName}" no longer has OAuth configured`,
    });
  }

  const redirectUri = buildRedirectUri({ publicAppUrl: getPublicAppUrl() });

  try {
    const tokens = await exchangeCodeForTokens({
      oauth: serverConfig.auth.oauth,
      redirectUri,
      code,
      codeVerifier: verifier,
    });

    const vaultKey = await storeOAuthTokenBundle({
      serverName,
      bundle: tokens,
    });

    // Record the vaultKey back into AppConfig so the bridge knows where
    // to load tokens from. Mutating the local config object + setConfig
    // is safe — getConfig deduped within this request gave us the latest
    // KV state, and setConfig re-validates with appConfigSchema.
    serverConfig.auth.oauth.vaultKey = vaultKey;
    await setConfig(appConfigSchema.parse(config));
  } catch (error) {
    clearCookies();
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('oauth_token_exchange_failed', { serverName, error: message });
    return redirectToConfig(returnTo, {
      error: 'token_exchange_failed',
      error_description: message,
    });
  }

  clearCookies();
  return redirectToConfig(returnTo, { connected: serverName });
}

function redirectToConfig(returnTo: string, params: Record<string, string>) {
  const url = new URL(returnTo, getPublicAppUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, { status: 303 });
}
