'use server';

import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import { db, schema } from '@/lib/core/db';
import {
  bulkSetTentativeStatus,
  getLongTermMemoryRow,
  listAllLongTermMemoryRows,
  listTentativeMemories,
  ratifyLongTermMemory,
  updateTentativeMemoryRow,
} from '@/lib/core/db/memory/long-term';
import { listUsers } from '@/lib/core/db/users';
import { getConfig } from '@/lib/core/kv/config';
import {
  createLongTermMemory,
  deleteLongTermMemory,
  getBuiltinMemorySection,
  listBuiltinMemorySections,
  listLongTermMemories,
  listSessionSummaries,
  reindexLongTermMemory,
  setBuiltinMemorySection,
  upsertLongTermMemory,
} from '@/lib/memory';
import { consolidatePhase } from '@/lib/memory/dream/phase1-consolidate';
import { sanitizeOperations } from '@/lib/memory/dream/phase3-sanitize';
import { buildProjectMemoryAggregate } from '@/lib/memory/project-aggregate';
import { invalidateProfileCache } from '@/lib/memory/profile';
import { invalidateRecallCache } from '@/lib/memory/recall';
import { invalidateTriggerCache } from '@/lib/memory/triggers';
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

/* ─── Dream proposals (tentative memories) ─────────────────────── */

export type DreamProposalRecord = {
  id: string;
  key: string | null;
  content: string;
  memoryType: string;
  importance: number;
  projectId: string;
  sourceKind: string;
  confidence: number | null;
  rationale: string | null;
  triggerPhrases: string[] | null;
  createdAt: string;
  updatedAt: string;
};

type TentativeRow = Awaited<ReturnType<typeof listTentativeMemories>>[number];

function mapProposalRow(row: TentativeRow): DreamProposalRecord {
  const meta = (row.dreamMeta ?? {}) as {
    confidence?: number;
    rationale?: string;
  };
  return {
    id: row.id,
    key: row.key ?? null,
    content: row.content,
    memoryType: row.memoryType,
    importance: row.importance,
    projectId: row.projectId,
    sourceKind: row.sourceKind,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
    rationale: typeof meta.rationale === 'string' ? meta.rationale : null,
    triggerPhrases: Array.isArray(row.triggerPhrases)
      ? row.triggerPhrases
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Drop every memory-derived cache for a user after a dream write. */
async function invalidateMemoryCaches(userId: string) {
  invalidateRecallCache(userId);
  invalidateTriggerCache(userId);
  await invalidateProfileCache(userId);
}

/** Fire-and-forget reindex so a written/edited row becomes searchable. */
async function scheduleReindex(memoryId: string) {
  const config = await getConfig().catch(() => null);
  reindexLongTermMemory({ memoryId, config: config ?? undefined }).catch(
    () => {},
  );
}

export async function listDreamProposalsAction(input?: { limit?: number }) {
  const access = await requireAuth();
  const limit = Math.min(Math.max(input?.limit ?? 100, 1), 200);

  const rows = await listTentativeMemories({
    userId: access.session.userId,
    limit,
  });

  return { proposals: rows.map(mapProposalRow) };
}

/**
 * Ratify (promote to active) or reject (demote to contradicted) a single
 * proposal. Re-ratified rows are re-indexed so they become searchable
 * immediately (dream writes go through the DAL and skip chunk indexing).
 */
export async function ratifyDreamProposalAction(input: {
  id: string;
  ratified: boolean;
  note?: string;
}) {
  const access = await requireAuth();
  const userId = access.session.userId;

  const updated = await ratifyLongTermMemory({
    id: input.id,
    userId,
    ratified: input.ratified,
    note: typeof input.note === 'string' ? input.note.slice(0, 500) : undefined,
  });
  if (!updated) {
    throw new Error('Proposal not found');
  }

  if (input.ratified) {
    await scheduleReindex(updated.id);
  }
  await invalidateMemoryCaches(userId);

  return { ok: true as const, dreamStatus: updated.dreamStatus };
}

/**
 * Edit a pending proposal before ratifying it: content, importance, and
 * trigger phrases are all adjustable. Restricted to tentative rows by
 * the DAL — an active/superseded memory can never be mutated here.
 */
export async function updateDreamProposalAction(input: {
  id: string;
  content?: string;
  importance?: number;
  triggerPhrases?: string[];
}) {
  const access = await requireAuth();
  const userId = access.session.userId;

  const triggerPhrases = Array.isArray(input.triggerPhrases)
    ? input.triggerPhrases
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length >= 2)
        .slice(0, 5)
    : undefined;

  const updated = await updateTentativeMemoryRow({
    id: input.id,
    userId,
    ...(typeof input.content === 'string' ? { content: input.content } : {}),
    ...(typeof input.importance === 'number'
      ? { importance: input.importance }
      : {}),
    ...(triggerPhrases !== undefined ? { triggerPhrases } : {}),
  });
  if (!updated) {
    throw new Error('Proposal not found or nothing to update');
  }

  if (typeof input.content === 'string' && input.content.trim().length > 0) {
    await scheduleReindex(updated.id);
  }
  await invalidateMemoryCaches(userId);

  return { ok: true as const, proposal: mapProposalRow(updated) };
}

/**
 * Hard-delete a proposal. Distinct from "reject": rejection marks the
 * finding contradicted so Dream never re-proposes it; deletion removes
 * the row entirely (it MAY be re-proposed by a future run).
 */
export async function deleteDreamProposalAction(id: string) {
  const access = await requireAuth();
  const userId = access.session.userId;

  // Guard: only tentative rows may be deleted through this path — an
  // active memory must go through deleteLongTermMemoryAction instead.
  const row = await getLongTermMemoryRow(id, { userId });
  if (row?.dreamStatus !== 'tentative') {
    throw new Error('Proposal not found');
  }

  const deleted = await deleteLongTermMemory(id, { userId });
  if (!deleted) {
    throw new Error('Proposal not found');
  }

  await invalidateMemoryCaches(userId);
  return { ok: true as const };
}

/**
 * Manually create a memory from the Dream tab. Written directly as
 * ACTIVE (a human review queue entry makes no sense for something the
 * human just typed) and classified user_asserted — the highest trust
 * class, since the user stated it themselves.
 */
export async function createDreamMemoryAction(input: {
  content: string;
  key?: string;
  memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
  importance?: number;
  triggerPhrases?: string[];
}) {
  const access = await requireAuth();
  const userId = access.session.userId;

  const content = input.content?.trim();
  if (!content) {
    throw new Error('content is required');
  }

  const triggerPhrases = Array.isArray(input.triggerPhrases)
    ? input.triggerPhrases
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length >= 2)
        .slice(0, 5)
    : undefined;

  const key = input.key?.trim();
  if (key) {
    // Stable-key writes go through upsert so re-creating the same key
    // updates instead of duplicating (same domain as the extractor).
    const result = await upsertLongTermMemory({
      userId,
      key,
      content,
      memoryType: input.memoryType,
      importance: input.importance,
      sourceKind: 'user_asserted',
      triggerPhrases,
    });
    await invalidateMemoryCaches(userId);
    return { ok: true as const, id: result.memory.id, created: result.created };
  }

  const result = await createLongTermMemory({
    content,
    memoryType: input.memoryType,
    importance: input.importance,
    userId,
    sourceKind: 'user_asserted',
    triggerPhrases,
  });
  await invalidateMemoryCaches(userId);
  return { ok: true as const, id: result.memory.id, created: true };
}

export async function batchDreamProposalsAction(input: {
  action: 'ratify-all' | 'reject-all';
}) {
  const access = await requireAuth();
  const userId = access.session.userId;

  if (input.action !== 'ratify-all' && input.action !== 'reject-all') {
    throw new Error('action must be "ratify-all" or "reject-all"');
  }

  // Capture ids before the bulk flip so ratified rows can be re-indexed
  // (dream-written rows have no chunks until indexed).
  const pending =
    input.action === 'ratify-all'
      ? await listTentativeMemories({ userId, limit: 200 })
      : [];

  const processed = await bulkSetTentativeStatus({
    userId,
    ratified: input.action === 'ratify-all',
  });

  if (input.action === 'ratify-all') {
    for (const row of pending) {
      await scheduleReindex(row.id);
    }
  }
  await invalidateMemoryCaches(userId);

  return { ok: true as const, processed };
}

/* ─── Dream run preview (dry-run, no writes) ───────────────────── */

export type DreamPreviewOperation = {
  type: 'CONSOLIDATE' | 'DELETE' | 'SUPERSEDE' | 'ADJUST_IMPORTANCE';
  /** Human-readable one-line summary of what would happen. */
  summary: string;
  /** Existing row ids the op would touch. */
  affectedIds: string[];
};

/**
 * Dry-run the next Dream sweep for the current user: phase 1 (usage
 * adjustments + LLM consolidation) followed by phase 3 (sanitize +
 * mutation budget), WITHOUT applying anything. Phase 2 (recombine) is
 * skipped — its proposals never mutate existing rows, and halving the
 * LLM cost keeps the preview responsive.
 *
 * This is the "explain" surface (OpenClaw `memory promote` preview
 * analogue): review exactly what tonight's run would merge, delete, and
 * re-weight before trusting it.
 */
export async function previewDreamRunAction() {
  const access = await requireAuth();
  const userId = access.session.userId;
  const config = await getConfig();

  const memories = await listAllLongTermMemoryRows({ userId });

  const phase1 = await consolidatePhase({ userId, config, memories });
  const retiredBudget = Math.max(5, Math.floor(memories.length * 0.25));
  const phase3 = sanitizeOperations(phase1.operations, {
    maxRetiredRows: retiredBudget,
  });

  const operations: DreamPreviewOperation[] = [];
  for (const op of phase3.accepted) {
    switch (op.type) {
      case 'CONSOLIDATE':
        operations.push({
          type: 'CONSOLIDATE',
          summary: `合并 ${op.sourceMemoryIds.length} 条 → [${op.mergedKey}] ${op.mergedContent.slice(0, 120)}`,
          affectedIds: op.sourceMemoryIds,
        });
        break;
      case 'DELETE':
        operations.push({
          type: 'DELETE',
          summary: `删除 ${op.memoryIds.length} 条记忆`,
          affectedIds: op.memoryIds,
        });
        break;
      case 'SUPERSEDE':
        operations.push({
          type: 'SUPERSEDE',
          summary: '标记 1 条近重复记忆为 superseded',
          affectedIds: [op.oldMemoryId],
        });
        break;
      case 'ADJUST_IMPORTANCE':
        operations.push({
          type: 'ADJUST_IMPORTANCE',
          summary: `重要性调整为 ${op.importance}（${op.reason === 'frequently_recalled' ? '高频召回' : '长期未召回'}）`,
          affectedIds: [op.memoryId],
        });
        break;
      default:
        break;
    }
  }

  return {
    memoryCount: memories.length,
    retiredBudget,
    operations,
    stats: {
      consolidated: phase1.stats.consolidated,
      deleted: phase1.stats.deleted,
      rejectedDuplicates: phase3.rejectedDuplicates,
      rejectedBudget: phase3.rejectedBudget,
    },
  };
}
