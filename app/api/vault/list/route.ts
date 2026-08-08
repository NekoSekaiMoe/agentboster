import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import { listUserVaultEntries, upsertUserVaultEntry } from '@/lib/extra/vault';
import { cookies } from 'next/headers';

export async function GET() {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    return Response.json({ success: false, error: 'Unauthorized' }, { status });
  }
  try {
    const entries = await listUserVaultEntries(access.session.userId);
    return Response.json({ success: true, data: entries });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list vault',
      },
      { status: 500 },
    );
  }
}

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
    const entry = await upsertUserVaultEntry({
      userId: access.session.userId,
      key: String(body.key ?? ''),
      value: String(body.value ?? ''),
    });
    return Response.json({ success: true, data: entry });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to write vault entry',
      },
      { status: 400 },
    );
  }
}
