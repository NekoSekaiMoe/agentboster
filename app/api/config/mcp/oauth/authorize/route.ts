/**
 * Start an OAuth Authorization Code + PKCE flow for an MCP server.
 *
 * POST /api/config/mcp/oauth/authorize
 *   body: { serverName: string, returnTo?: string }
 *
 * Sets short-lived cookies holding the PKCE verifier + state + server
 * name (so the callback knows which server the code is for), then
 * responds with the authorize URL the client should redirect to.
 *
 * Why POST not GET: the authorize URL embeds client_id + redirect_uri
 * tied to the admin's currently-viewed server config. GET would let a
 * CSRF attacker trick an admin into starting an OAuth flow for an
 * arbitrary serverName — harmless (state cookie still gates the
 * callback) but noisy in audit logs.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { getConfig } from '@/lib/core/kv/config';
import { getPublicAppUrl } from '@/lib/deploy';
import {
  OAUTH_COOKIE_NAMES,
  buildAuthorizeUrl,
  buildRedirectUri,
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '@/lib/mcp/oauth-flow';
import { cookies } from 'next/headers';
import { z } from 'zod';

const COOKIE_MAX_AGE_SECONDS = 10 * 60; // OAuth round-trip shouldn't take 10 min

const requestSchema = z.object({
  serverName: z.string().min(1).max(64),
  returnTo: z.string().max(512).optional(),
});

export async function POST(request: Request) {
  const cookieStore = await cookies();

  try {
    await requireAdminAccess(cookieStore);
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error
        ? (error as { status: number }).status
        : 401;
    return Response.json({ success: false, error: 'Unauthorized' }, { status });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: 'Invalid request',
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }
  const { serverName, returnTo } = parsed.data;

  const config = await getConfig();
  const serverConfig = config.mcp?.[serverName];
  if (!serverConfig?.auth?.oauth) {
    return Response.json(
      {
        success: false,
        error: `Server "${serverName}" is not configured for OAuth`,
      },
      { status: 400 },
    );
  }

  const verifier = generateCodeVerifier();
  const challenge = computeCodeChallenge(verifier);
  const state = generateState();
  const redirectUri = buildRedirectUri({
    publicAppUrl: getPublicAppUrl(),
  });

  const authorizeUrl = buildAuthorizeUrl({
    oauth: serverConfig.auth.oauth,
    redirectUri,
    state,
    codeChallenge: challenge,
  });

  // Cookie attributes: HttpOnly (JS can't read), Secure (production only —
  // Next sets this via the 'secure' flag automatically when not on http),
  // SameSite=Lax (lets the OAuth callback land top-level), path=/ (the
  // callback is in a different URL prefix than the authorizer).
  cookieStore.set(OAUTH_COOKIE_NAMES.pkce, verifier, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  cookieStore.set(OAUTH_COOKIE_NAMES.state, state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  cookieStore.set(OAUTH_COOKIE_NAMES.server, serverName, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  if (returnTo) {
    cookieStore.set(OAUTH_COOKIE_NAMES.returnTo, returnTo, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: '/',
    });
  }

  return Response.json({
    success: true,
    data: { authorizeUrl, serverName },
  });
}
