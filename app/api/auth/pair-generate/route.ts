import { requireAuthAccess } from '@/lib/auth/access';
import { generatePairCode } from '@/lib/auth/pair-code';

/**
 * POST /api/auth/pair-generate
 *
 * Issues a one-shot pair code for the authenticated user. The user
 * pastes this code into `agentboster login --pair-code <code>` on
 * their CLI to authenticate without re-entering username/password.
 *
 * Auth: cookie-based (web UI session). Not accessible from CLI.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore);
  if (!access) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const code = await generatePairCode({
    userId: access.session.userId,
    username: access.session.username,
    label: body.label,
  });

  return Response.json({
    ok: true,
    code,
    expiresIn: 300,
  });
}

import { cookies } from 'next/headers';
