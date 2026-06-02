'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import { db, schema } from '@/lib/core/db';
import {
  createLongTermMemory,
  deleteLongTermMemory,
  getBuiltinMemorySection,
  listBuiltinMemorySections,
  listLongTermMemories,
  listSessionSummaries,
  setBuiltinMemorySection,
} from '@/lib/memory';
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
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

export async function listBuiltinMemorySectionsAction() {
  await requireAuth();

  const sections = await listBuiltinMemorySections();
  return { sections };
}

export async function updateBuiltinMemorySectionAction(input: unknown) {
  await requireAuth();

  const parsed = updateBuiltinMemorySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  return setBuiltinMemorySection(parsed.data.key, parsed.data.content);
}

export async function listLongTermMemoriesAction(input?: {
  page?: number;
  pageSize?: number;
  search?: string;
}) {
  await requireAuth();

  const parsed = longTermMemoryListQuerySchema.safeParse({
    page: input?.page,
    pageSize: input?.pageSize,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  const items = await listLongTermMemories({
    ...parsed.data,
    search: input?.search?.trim() || undefined,
  });

  return {
    items: items.map((item) => ({
      id: item.id,
      content: item.content,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })) satisfies LongTermMemoryRecord[],
  };
}

export async function createLongTermMemoryAction(input: unknown) {
  await requireAuth();

  const parsed = createLongTermMemorySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

  return createLongTermMemory(parsed.data);
}

export async function deleteLongTermMemoryAction(id: string) {
  await requireAuth();

  const memoryId = id.trim();
  if (!memoryId) {
    throw new Error('Memory id is required');
  }

  const deleted = await deleteLongTermMemory(memoryId);
  if (!deleted) {
    throw new Error('Memory not found');
  }

  return { ok: true as const };
}

export async function listSessionSummariesAction(input: { sessionId: string }) {
  await requireAuth();

  const parsed = sessionMemoryQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Validation failed');
  }

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
  await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

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
  await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

  const trimmed = content.slice(0, SOUL_MEMORY_MAX_LENGTH);

  await db
    .update(schema.sessions)
    .set({ soulContent: trimmed })
    .where(eq(schema.sessions.id, sid));

  return { ok: true as const, truncated: content.length > SOUL_MEMORY_MAX_LENGTH };
}

export async function clearSessionSoulAction(sessionId: string) {
  await requireAuth();

  const sid = sessionId.trim();
  if (!sid) {
    throw new Error('Session ID is required');
  }

  await db
    .update(schema.sessions)
    .set({ soulContent: null })
    .where(eq(schema.sessions.id, sid));

  return { ok: true as const };
}
