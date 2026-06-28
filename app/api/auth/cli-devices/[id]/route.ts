import { revokeCliDevice } from '@/lib/core/db/cli-devices';
import { requireAuthAccess } from '@/lib/auth/access';
import { cookies } from 'next/headers';

/**
 * DELETE /api/auth/cli-devices/[id]
 *
 * Revoke a paired CLI device. Sets `revoked_at` on the device row;
 * subsequent CLI requests carrying that device's jti will be rejected
 * by `requireCliAuth`.
 */
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore).catch(() => null);
  if (!access) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const updated = await revokeCliDevice({
    deviceId: id,
    userId: access.session.userId,
  });

  if (!updated) {
    return Response.json(
      { ok: false, error: 'Device not found or already revoked' },
      { status: 404 },
    );
  }

  return Response.json({ ok: true });
}
