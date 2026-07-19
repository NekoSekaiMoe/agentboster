/**
 * Side-effect-free OAuth metadata for the MCP config UI.
 *
 * GET /api/config/mcp/oauth/metadata
 *
 * Returns the resolved OAuth redirect URI (derived from getPublicAppUrl)
 * so the admin can copy-paste it into the provider's allow-list WITHOUT
 * triggering an authorize round-trip. The authorize endpoint
 * (/api/config/mcp/oauth/authorize) is intentionally side-effectful —
 * it mints PKCE/state and writes four flow cookies — so calling it from
 * a row-mount useEffect (one fetch per OAuth-enabled server, racing
 * with the user's Connect click) caused cookie collisions and state
 * mismatch failures. This route is read-only and safe to call on every
 * mount.
 *
 * Auth: admin-only.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { getPublicAppUrl } from '@/lib/extra/deploy';
import { buildRedirectUri } from '@/lib/mcp/oauth-flow';
import { cookies } from 'next/headers';

export async function GET() {
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

  const redirectUri = buildRedirectUri({ publicAppUrl: getPublicAppUrl() });
  return Response.json({
    success: true,
    data: { redirectUri },
  });
}
