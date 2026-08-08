import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import { readUserVaultValue } from '@/lib/extra/vault';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    return Response.json({ success: false, error: 'Unauthorized' }, { status });
  }

  try {
    const body = await request.json();
    const entry = await readUserVaultValue({
      userId: access.session.userId,
      key: String(body.key ?? ''),
    });
    if (!entry) {
      return Response.json(
        { success: false, error: 'Vault entry not found' },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: entry });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read vault',
      },
      { status: 400 },
    );
  }
}
