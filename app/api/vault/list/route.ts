import { readAuthSessionFromCookies } from '@/lib/auth';
import { listVaultEntries, upsertVaultEntry } from '@/lib/extra/vault';
import { cookies } from 'next/headers';

async function requireUser() {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    throw new Error('Unauthorized');
  }
  return session;
}

export async function GET() {
  try {
    const session = await requireUser();
    const entries = await listVaultEntries(session.userId);
    return Response.json({ success: true, data: entries });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list vault';
    return Response.json(
      { success: false, error: message },
      { status: message === 'Unauthorized' ? 401 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireUser();
    const body = await request.json();
    const entry = await upsertVaultEntry({
      key: String(body.key ?? ''),
      value: String(body.value ?? ''),
      userId: session.userId,
    });
    return Response.json({ success: true, data: entry });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to write vault entry';
    return Response.json(
      { success: false, error: message },
      { status: message === 'Unauthorized' ? 401 : 400 },
    );
  }
}
