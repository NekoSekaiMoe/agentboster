import { consumePairCode } from '@/lib/auth/pair-code';
import { createAuthToken } from '@/lib/auth/session';

/**
 * POST /api/auth/pair-exchange
 *
 * Exchange a pair code for a full auth token. Called by the CLI
 * (`agentboster login --pair-code <code>`). The pair code is
 * one-shot — consumed on first use.
 *
 * No cookie/session required: the pair code itself is the proof
 * of identity (issued by an authenticated web UI user).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    pairCode?: string;
    label?: string;
  };

  if (!body.pairCode) {
    return Response.json(
      { ok: false, error: 'pairCode is required' },
      { status: 400 },
    );
  }

  const entry = await consumePairCode(body.pairCode);
  if (!entry) {
    return Response.json(
      { ok: false, error: 'Invalid or expired pair code' },
      { status: 403 },
    );
  }

  const token = await createAuthToken(entry.userId, entry.username);

  return Response.json({
    ok: true,
    token,
    username: entry.username,
  });
}
