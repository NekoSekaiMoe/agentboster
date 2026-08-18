import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me — lightweight identity probe for client chrome
 * (sidebar, workspace switcher, session list) that needs the caller's
 * userId/isAdmin OUTSIDE the /config subtree. The heavyweight
 * ConfigProvider (full config draft + runtime health) stays under
 * /config; this endpoint exists so chat surfaces don't have to import it.
 */
export async function GET() {
  const cookieStore = await cookies();
  try {
    const access = await requireAuthAccess(cookieStore);
    return Response.json(
      {
        userId: access.session.userId,
        username: access.user.username,
        isAdmin: access.isAdmin,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
