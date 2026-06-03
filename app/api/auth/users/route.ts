import { readAuthSessionFromCookies } from '@/lib/auth';
import { createUser, listUsers } from '@/lib/core/db/users';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function GET() {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const users = await listUsers();
  return NextResponse.json(
    users.map((u) => ({ id: u.id, username: u.username, roles: u.roles, createdAt: u.createdAt })),
  );
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return NextResponse.json(
      { error: 'Username and password are required.' },
      { status: 400 },
    );
  }

  try {
    const user = await createUser(username, password);
    return NextResponse.json(
      { id: user.id, username: user.username, roles: user.roles },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
