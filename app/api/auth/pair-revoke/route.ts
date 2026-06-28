import { requireAuthAccess } from '@/lib/auth/access';
import { revokePairCode } from '@/lib/auth/pair-code';
import { cookies } from 'next/headers';

/**
 * POST /api/auth/pair-revoke
 *
 * Cancel an unconsumed pair code issued by the authenticated user.
 * Body: { code: string }.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore).catch(() => null);
  if (!access) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { code?: string };
  if (!body.code) {
    return Response.json(
      { ok: false, error: 'code is required' },
      { status: 400 },
    );
  }

  const removed = await revokePairCode(body.code);
  return Response.json({ ok: true, removed });
}
