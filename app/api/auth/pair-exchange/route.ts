import { randomUUID } from 'node:crypto';
import { createCliDevice } from '@/lib/core/db/cli-devices';
import { consumePairCode } from '@/lib/auth/pair-code';
import { createAuthToken } from '@/lib/auth/session';

/**
 * POST /api/auth/pair-exchange
 *
 * Exchange a pair code for a full auth token. Called by the CLI
 * (`agentboster login --pair-code <code>`). The pair code is
 * one-shot — consumed on first use.
 *
 * On success a `cli_devices` row is created, and the token's payload
 * carries its id as `jti` so the web UI can later revoke the device.
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

  const jti = randomUUID();
  await createCliDevice({
    clawlessUserId: entry.userId,
    label: body.label ?? entry.label ?? null,
    tokenJti: jti,
  });

  const token = await createAuthToken(entry.userId, entry.username, { jti });

  return Response.json({
    ok: true,
    token,
    username: entry.username,
  });
}
