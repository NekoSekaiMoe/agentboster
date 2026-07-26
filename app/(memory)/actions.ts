'use server';

import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import { db, schema } from '@/lib/core/db';
import { listUsers } from '@/lib/core/db/users';
import {
  createLongTermMemory,
  deleteLongTermMemory,
  getBuiltinMemorySection,
  listBuiltinMemorySections,
  listLongTermMemories,
  listSessionSummaries,
  setBuiltinMemorySection,
} from '@/lib/memory';
import { buildProjectMemoryAggregate } from '@/lib/memory/project-aggregate';
import {
  createLongTermMemorySchema,
  longTermMemoryListQuerySchema,
  sessionMemoryQuerySchema,
  updateBuiltinMemorySchema,
} from '@/types/memory';
import { SOUL_MEMORY_MAX_LENGTH } from '@/types/memory/builtin';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';

export type BuiltinMemorySectionRecord = {
  key: string;
  content: string;
  updatedAt: string | null;
};

export type LongTermMemoryRecord = {
  id: string;
  userId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSummaryRecord = {
  id: string;
  sessionId: string;
  content: string;
  summaryVersion: number;
  isCurrent: boolean;
  createdAt: string;
};

async function requireAuth() {
  const cookieStore = await cookies();
  return requireAuthAccess(cookieStore);
}

export async function listBuiltinMemorySectionsAction() {
  await requireAuth();

  const sections = await listBuiltinMemorySections();
  return { sections };
}

export async function updateBuiltinMemorySectionAction(input: unknown) {
  const access = await requireAuth();
  if (!access.isAdmin) {
    throw new Error('Forbidden');
  }

  const parsed = updateBuiltinMemorySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  return setBuiltinMemorySection(parsed.data.key, parsed.data.content);
}

export async function listMemoryAuthorsAction() {
  const access = await requireAuth();
  if (!access.isAdmin) {
    return { authors: [], isAdmin: false as const };
  }

  const users = await listUsers();
  // Always include the synthetic 'system' owner so memories written by
  // background tasks (no associated user) display a friendly label.
  return {
    authors: [
      { id: 'system', username: 'system' },
      ...users.map((u) => ({ id: u.id, username: u.username })),
    ],
    isAdmin: true as const,
  };
}

export async function listLongTermMemoriesAction(input?: {
  page?: number;
  pageSize?: number;
  search?: string;
  userId?: string | null;
}) {
  const access = await requireAuth();

  const parsed = longTermMemoryListQuerySchema.safeParse({
    page: input?.page,
    pageSize: input?.pageSize,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  // Admin sees memories from all users (aggregated view) unless they
  // explicitly filter by a specific userId. Non-admins are always
  // scoped to their own userId.
  const targetUserId = !access.isAdmin
    ? access.session.userId
    : input?.userId?.trim()
      ? input.userId.trim()
      : undefined;

  const items = await listLongTermMemories({
    ...parsed.data,
    search: input?.search?.trim() || undefined,
    userId: targetUserId,
  });

  return {
    items: items.map((item) => ({
      id: item.id,
      userId: item.userId ?? null,
      content: item.content,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })) satisfies LongTermMemoryRecord[],
  };
}

export async function createLongTermMemoryAction(input: unknown) {
  const access = await requireAuth();

  const parsed = createLongTermMemorySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  // Admins can target a different userId (e.g. write to 'system'). The
  // userId field is read from the raw input because createLongTermMemorySchema
  // is the user-facing shape and does not declare it.
  const requestedUserId =
    typeof input === 'object' &&
    input !== null &&
    'userId' in input &&
    typeof (input as { userId: unknown }).userId === 'string'
      ? (input as { userId: string }).userId.trim()
      : '';

  const targetUserId =
    access.isAdmin && requestedUserId.length > 0
      ? requestedUserId
      : access.session.userId;

  return createLongTermMemory({
    ...parsed.data,
    userId: targetUserId,
  });
}

export async function deleteLongTermMemoryAction(
  id: string,
  options?: { userId?: string | null },
) {
  const access = await requireAuth();

  const memoryId = id.trim();
  if (!memoryId) {
    throw new Error('Memory id is required');
  }

  // Non-admins are always scoped to their own userId (security boundary).
  // Admins can delete anyone's memory: by default they delete by id
  // without a userId filter, and they can pass an explicit userId to
  // further restrict the delete to a specific owner.
  const targetUserId = !access.isAdmin
    ? access.session.userId
    : options?.userId?.trim()
      ? options.userId.trim()
      : undefined;

  const deleted = await deleteLongTermMemory(memoryId, {
    userId: targetUserId,
  });
  if (!deleted) {
    throw new Error('Memory not found');
  }

  return { ok: true as const };
}

export async function listSessionSummariesAction(input: { sessionId: string }) {
  const access = await requireAuth();

  const parsed = sessionMemoryQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const session = await getSession(parsed.data.sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  assertCanAccessOwnedResource(access, session.userId);

  const summaries = await listSessionSummaries(parsed.data.sessionId);

  return {
    sessionId: parsed.data.sessionId,
    summaries: summaries.map((summary) => ({
      id: summary.id,
      sessionId: summary.sessionId,
      content: summary.content,
      summaryVersion: summary.summaryVersion,
      isCurrent: summary.isCurrent,
      createdAt: summary.createdAt.toISOString(),
    })) satisfies SessionSummaryRecord[],
  };
}

export async function getSessionSoulAction(sessionId: string) {
  const access = await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

  const targetSession = await getSession(sid);
  if (!targetSession) {
    throw new Error('Session not found');
  }
  assertCanAccessOwnedResource(access, targetSession.userId);

  const [session] = await db
    .select({ soulContent: schema.sessions.soulContent })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sid))
    .limit(1);

  if (session?.soulContent) {
    return { content: session.soulContent, scope: 'session' as const };
  }

  const section = await getBuiltinMemorySection('SOUL');
  return { content: section.content, scope: 'global' as const };
}

export async function setSessionSoulAction(sessionId: string, content: string) {
  const access = await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

  const targetSession = await getSession(sid);
  if (!targetSession) {
    throw new Error('Session not found');
  }
  assertCanAccessOwnedResource(access, targetSession.userId);

  const trimmed = content.slice(0, SOUL_MEMORY_MAX_LENGTH);

  await db
    .update(schema.sessions)
    .set({ soulContent: trimmed })
    .where(eq(schema.sessions.id, sid));

  return {
    ok: true as const,
    truncated: content.length > SOUL_MEMORY_MAX_LENGTH,
  };
}

export async function clearSessionSoulAction(sessionId: string) {
  const access = await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

  const targetSession = await getSession(sid);
  if (!targetSession) {
    throw new Error('Session not found');
  }
  assertCanAccessOwnedResource(access, targetSession.userId);

  await db
    .update(schema.sessions)
    .set({ soulContent: null })
    .where(eq(schema.sessions.id, sid));

  return { ok: true as const };
}

export type ProjectMemoryEntryRecord = {
  id: string;
  content: string;
  memoryType: 'fact' | 'preference' | 'decision' | 'conversation';
  importance: number;
  updatedAt: string;
};

export type ProjectMemoryGroupRecord = {
  projectId: string;
  label: string;
  isGlobal: boolean;
  memoryCount: number;
  memories: ProjectMemoryEntryRecord[];
};

/**
 * Project-aggregate memory view (ref_revica.md §2.1). Returns long-term
 * memories grouped by project so the memory tab can render a browsable
 * "what does the agent know about each project" view instead of a flat
 * list. Admins see the same shape, scoped to their own userId unless they
 * pass an explicit target (mirroring listLongTermMemoriesAction).
 */
export async function listProjectMemoryGroupsAction(input?: {
  userId?: string | null;
  projectIdScope?: string | null;
}): Promise<{ groups: ProjectMemoryGroupRecord[] }> {
  const access = await requireAuth();

  const targetUserId = !access.isAdmin
    ? access.session.userId
    : input?.userId?.trim()
      ? input.userId.trim()
      : undefined;

  const groups = await buildProjectMemoryAggregate({
    userId: targetUserId,
    projectIdScope: input?.projectIdScope ?? null,
  });

  return {
    groups: groups.map((g) => ({
      projectId: g.projectId,
      label: g.label,
      isGlobal: g.isGlobal,
      memoryCount: g.memories.length,
      // Trim memories to the most recent N per group for the overview —
      // the flat Long-term panel remains the place to see/search every
      // row. Keeps the aggregate view light even for power users.
      memories: g.memories.slice(0, 8).map((m) => ({
        id: m.id,
        content: m.content,
        memoryType: m.memoryType,
        importance: m.importance,
        updatedAt: m.updatedAt.toISOString(),
      })),
    })),
  };
}

/**
 * Convenience: list just the distinct project scopes a user has memories
 * for, without the memory rows. Used by sidebar / filter dropdowns.
 */
export async function listProjectScopesAction(input?: {
  userId?: string | null;
}): Promise<Array<{ projectId: string; label: string; isGlobal: boolean }>> {
  const access = await requireAuth();

  const targetUserId = !access.isAdmin
    ? access.session.userId
    : input?.userId?.trim()
      ? input.userId.trim()
      : undefined;

  const groups = await buildProjectMemoryAggregate({
    userId: targetUserId,
  });

  return groups.map((g) => ({
    projectId: g.projectId,
    label: g.label,
    isGlobal: g.isGlobal,
  }));
}
