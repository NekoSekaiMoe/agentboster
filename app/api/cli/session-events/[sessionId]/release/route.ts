import { NextRequest } from 'next/server';
import { getSession } from '@/lib/core/db/repositories/sessions';
import { readAuthSessionFromRequest } from '@/lib/auth/session';
import { markCliOffline } from '@/lib/cli/remote-control';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('cli-session-events-release');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/cli/session-events/[sessionId]/release
 *
 * Mark CLI as offline (graceful disconnect).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authSession = await readAuthSessionFromRequest(req);
  if (!authSession) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const session = await getSession(sessionId, { userId: authSession.userId });
  if (!session) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  await markCliOffline(sessionId);
  logger.info('CLI released (marked offline)', { sessionId });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
