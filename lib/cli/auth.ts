import { readAuthSessionFromRequest, type AuthSession } from '@/lib/auth';

/**
 * Resolve the CLI auth session from the request's Authorization: Bearer
 * header (or cookie fallback). Used by /api/cli/* route handlers as a
 * reusable auth entry point. Throws a Response on failure so the route
 * can return it directly via `try { requireCliAuth } catch (r) { return r }`.
 */
export async function requireCliAuth(request: Request): Promise<AuthSession> {
  const session = await readAuthSessionFromRequest(request);
  if (!session) {
    throw new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}

/**
 * Wrap a CLI route handler so requireCliAuth's thrown Response is
 * forwarded as-is, and any other thrown error becomes a 500.
 *
 * Usage:
 *   export const GET = withCliAuth(async (request, { userId }) => {
 *     ...
 *     return Response.json({ ... });
 *   });
 */
export function withCliAuth(
  handler: (
    request: Request,
    ctx: { userId: string },
  ) => Promise<Response> | Response,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    let userId: string;
    try {
      const session = await requireCliAuth(request);
      userId = session.userId;
    } catch (errorOrResponse) {
      if (errorOrResponse instanceof Response) {
        return errorOrResponse;
      }
      return Response.json(
        { ok: false, error: 'Authentication failed.' },
        { status: 500 },
      );
    }

    try {
      return await handler(request, { userId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  };
}
