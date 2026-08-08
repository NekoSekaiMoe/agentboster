import { readAuthSessionFromCookies } from '@/lib/auth';
import { readUserVaultValue } from '@/lib/extra/vault';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  try {
    const body = await request.json();
    const entry = await readUserVaultValue({
      userId: session.userId,
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
