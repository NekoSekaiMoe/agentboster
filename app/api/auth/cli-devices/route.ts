import { listAllCliDevicesByUser } from '@/lib/core/db/cli-devices';
import { listPairCodesForUser } from '@/lib/auth/pair-code';
import { requireAuthAccess } from '@/lib/auth/access';
import { cookies } from 'next/headers';

/**
 * GET /api/auth/cli-devices
 *
 * List all paired CLI devices and currently active pair codes for the
 * authenticated user.
 */
export async function GET() {
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore).catch(() => null);
  if (!access) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const [devices, pairCodes] = await Promise.all([
    listAllCliDevicesByUser(access.session.userId),
    listPairCodesForUser(access.session.userId),
  ]);

  return Response.json({
    ok: true,
    devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      pairedAt: d.pairedAt.toISOString(),
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
      active: d.revokedAt === null,
    })),
    pairCodes,
  });
}
