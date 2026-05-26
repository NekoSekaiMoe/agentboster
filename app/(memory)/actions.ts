'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  createLongTermMemory,
  deleteLongTermMemory,
  listBuiltinMemorySections,
  listLongTermMemories,
  listSessionSummaries,
  setBuiltinMemorySection,
} from '@/lib/memory';
import { cookies } from 'next/headers';
import {
  createLongTermMemorySchema,
  longTermMemoryListQuerySchema,
  sessionMemoryQuerySchema,
  updateBuiltinMemorySchema,
} from '@/types/memory';

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
