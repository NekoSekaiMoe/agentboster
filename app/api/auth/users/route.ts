import { readAuthSessionFromCookies } from '@/lib/auth';
import { createUser, getUserById, listUsers, deleteUser } from '@/lib/core/db/users';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

async function requireAdmin() {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    throw new Error('Unauthorized');
  }
  const user = await getUserById(session.userId);
  if (!user || !user.roles.includes('admin')) {
    throw new Error('Forbidden');
  }
  return session;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const users = await listUsers();
  return NextResponse.json(
    users.map((u) => ({ id: u.id, username: u.username, roles: u.roles, createdAt: u.createdAt })),
  );
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { username, password, roles } = body as { username?: string; password?: string; roles?: string[] };

  if (!username || !password) {
    return NextResponse.json(
      { error: 'Username and password are required.' },
      { status: 400 },
    );
  }

  try {
    const user = await createUser(username, password, { roles });
    return NextResponse.json(
      { id: user.id, username: user.username, roles: user.roles },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

export async function DELETE(request: NextRequest) {
  let session;
  try {
    session = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { id } = body as { id?: string };

  if (!id) {
    return NextResponse.json({ error: 'User ID is required.' }, { status: 400 });
  }

  if (id === session.userId) {
    return NextResponse.json({ error: 'Cannot delete yourself.' }, { status: 400 });
  }

  const userToDelete = await getUserById(id);
  if (!userToDelete) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  const seedUsername = process.env.USERNAME?.trim();
  if (seedUsername && userToDelete.username === seedUsername) {
    return NextResponse.json(
      { error: 'Cannot delete the seed user configured via environment variables.' },
      { status: 400 },
    );
  }

  const deleted = await deleteUser(id);
  if (!deleted) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
