import { requireAdminAccess } from '@/lib/auth/access';
import {
  countSessionsByUserIds,
  getSession,
  listUserSessions,
} from '@/lib/core/db/chat';
import { cleanupChatSession } from '@/lib/chat/session-cleanup';
import { countFilesByUserIds, listFiles } from '@/lib/core/db/files';
import { countLongTermMemoriesByUserIds } from '@/lib/core/db/memory/long-term';
import {
  canGrantRoles,
  createUser,
  deleteUser,
  getUserById,
  invalidRoles,
  isSeedAdminUser,
  listUsers,
  normalizeRoles,
  updateUserPassword,
  updateUserRoles,
} from '@/lib/core/db/users';
import { deleteLongTermMemory, listLongTermMemories } from '@/lib/memory';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';

async function requireAdmin() {
  const cookieStore = await cookies();
  return requireAdminAccess(cookieStore);
}

function serializeUser(user: Awaited<ReturnType<typeof getUserById>>) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    roles: user.roles,
    isSeedAdmin: isSeedAdminUser(user),
    createdAt: user.createdAt.toISOString(),
  };
}

function normalizeUserId(value: string | null) {
  return value?.trim() || null;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const targetUserId = normalizeUserId(searchParams.get('id'));

  if (targetUserId && searchParams.get('includeData') === '1') {
    const user = await getUserById(targetUserId);
    if (!user) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    const [sessions, files, memories] = await Promise.all([
      listUserSessions({ userId: targetUserId, limit: 50 }),
      listFiles({ userId: targetUserId, limit: 50 }),
      listLongTermMemories({
        userId: targetUserId,
        page: 1,
        pageSize: 50,
      }),
    ]);

    return NextResponse.json({
      user: serializeUser(user),
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        channel: session.channel,
        status: session.status,
        totalTokens: session.totalTokens,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      })),
      files: files.files.map((file) => ({
        id: file.id,
        sessionId: file.sessionId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        createdAt: file.createdAt.toISOString(),
      })),
      memories: memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      })),
    });
  }

  const users = await listUsers();
  const userIds = users.map((user) => user.id);
  const includeStats = searchParams.get('includeStats') === '1';
  const [sessionCounts, fileCounts, memoryCounts] = includeStats
    ? await Promise.all([
        countSessionsByUserIds(userIds),
        countFilesByUserIds(userIds),
        countLongTermMemoriesByUserIds(userIds),
      ])
    : [
        new Map<string, number>(),
        new Map<string, number>(),
        new Map<string, number>(),
      ];

  return NextResponse.json(
    users.map((user) => ({
      ...serializeUser(user),
      stats: includeStats
        ? {
            sessions: sessionCounts.get(user.id) ?? 0,
            files: fileCounts.get(user.id) ?? 0,
            memories: memoryCounts.get(user.id) ?? 0,
          }
        : undefined,
    })),
  );
}

export async function POST(request: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    caller = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { username, password, roles } = body as {
    username?: string;
    password?: string;
    roles?: string[];
  };

  if (!username || !password) {
    return NextResponse.json(
      { error: 'Username and password are required.' },
      { status: 400 },
    );
  }

  const badRoles = invalidRoles(roles);
  if (badRoles.length > 0) {
    return NextResponse.json(
      { error: `Invalid roles: ${badRoles.join(', ')}` },
      { status: 400 },
    );
  }

  const requestedRoles = normalizeRoles(roles);
  if (!canGrantRoles(caller.user.roles, requestedRoles)) {
    return NextResponse.json(
      { error: 'You are not allowed to grant one or more requested roles.' },
      { status: 403 },
    );
  }

  try {
    const user = await createUser(username, password, {
      roles: requestedRoles,
    });
    return NextResponse.json(serializeUser(user), { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

export async function PATCH(request: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    caller = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { id, password, roles } = body as {
    id?: string;
    password?: string;
    roles?: string[];
  };
  const userId = id?.trim();
  const newPassword = password?.trim();

  if (!userId) {
    return NextResponse.json(
      { error: 'User ID is required.' },
      { status: 400 },
    );
  }

  const userToUpdate = await getUserById(userId);
  if (!userToUpdate) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  if (typeof password === 'string' && !newPassword) {
    return NextResponse.json(
      { error: 'Password is required.' },
      { status: 400 },
    );
  }

  if (newPassword) {
    const updated = await updateUserPassword(userId, newPassword);
    if (!updated) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    return NextResponse.json(serializeUser(updated));
  }

  if (isSeedAdminUser(userToUpdate)) {
    return NextResponse.json(
      { error: 'Cannot change roles for a seed admin user.' },
      { status: 400 },
    );
  }

  const badRoles = invalidRoles(roles);
  if (badRoles.length > 0) {
    return NextResponse.json(
      { error: `Invalid roles: ${badRoles.join(', ')}` },
      { status: 400 },
    );
  }

  const requestedRoles = normalizeRoles(roles);
  if (!canGrantRoles(caller.user.roles, requestedRoles)) {
    return NextResponse.json(
      { error: 'You are not allowed to grant one or more requested roles.' },
      { status: 403 },
    );
  }

  const updated = await updateUserRoles(userId, requestedRoles);
  if (!updated) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  return NextResponse.json(serializeUser(updated));
}

export async function DELETE(request: NextRequest) {
  let admin: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    admin = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { id, resource, resourceId } = body as {
    id?: string;
    resource?: 'user' | 'session' | 'memory';
    resourceId?: string;
  };
  const userId = id?.trim();

  if (!userId) {
    return NextResponse.json(
      { error: 'User ID is required.' },
      { status: 400 },
    );
  }

  const targetUser = await getUserById(userId);
  if (!targetUser) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  if (resource === 'session') {
    const sessionId = resourceId?.trim();
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required.' },
        { status: 400 },
      );
    }

    const session = await getSession(sessionId);
    if (!session || session.userId !== userId) {
      return NextResponse.json(
        { error: 'Session not found.' },
        { status: 404 },
      );
    }

    const cleanup = await cleanupChatSession(session);
    return NextResponse.json({ ok: cleanup.deleted, cleanup });
  }

  if (resource === 'memory') {
    const memoryId = resourceId?.trim();
    if (!memoryId) {
      return NextResponse.json(
        { error: 'Memory ID is required.' },
        { status: 400 },
      );
    }

    const deleted = await deleteLongTermMemory(memoryId, { userId });
    if (!deleted) {
      return NextResponse.json({ error: 'Memory not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  }

  if (userId === admin.session.userId) {
    return NextResponse.json(
      { error: 'Cannot delete yourself.' },
      { status: 400 },
    );
  }

  if (isSeedAdminUser(targetUser)) {
    return NextResponse.json(
      {
        error:
          'Cannot delete a seed admin user configured via environment variables.',
      },
      { status: 400 },
    );
  }

  const deleted = await deleteUser(userId);
  if (!deleted) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
