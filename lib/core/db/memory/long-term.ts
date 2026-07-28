import { db, schema } from '@/lib/core/db';
import {
  type HybridSearchRow,
  getHybridCandidateLimit,
  mergeHybridSearchCandidates,
} from '@/lib/memory/search';
import { resolveProjectId } from '@/lib/memory/scope';
import { createLogger } from '@/lib/utils/logger';
import {
  and,
  cosineDistance,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from 'drizzle-orm';

const logger = createLogger('db.memory.long_term');

type LongTermChunkInput = {
  chunkIndex: number;
  content: string;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
};

function buildSearchTextPreview(value?: string) {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? '';

  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117)}...`;
}

function roundScore(value: number) {
  return Number(value.toFixed(4));
}

function summarizeHybridRows(rows: HybridSearchRow[]) {
  return rows.slice(0, 5).map((row) => ({
    chunkId: row.chunkId,
    memoryId: row.memoryId,
    vectorScore: roundScore(row.vectorScore),
    keywordScore: roundScore(row.keywordScore),
    finalScore: roundScore(row.finalScore),
  }));
}

function containsCjk(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(value);
}

/**
 * Build the projectId WHERE condition for recall/list queries.
 *
 * Semantics:
 * - scope undefined / null → no filter (callers that don't care yet;
 *   returns ALL memories, matching pre-project-scoping behavior).
 * - scope = GLOBAL sentinel → only global memories.
 * - scope = a real project id → that project's memories PLUS global ones.
 *   This is the key design decision: when a user is working inside a
 *   project, we never want to hide their global preferences/profile —
 *   that would be a recall regression ("why did the agent forget I like
 *   early-return?"). So project scope is an additive filter, not a
 *   replacement.
 */
function buildProjectScopeCondition(projectIdScope?: string | null) {
  if (projectIdScope === undefined || projectIdScope === null) {
    return undefined;
  }
  const resolved = resolveProjectId(projectIdScope);
  if (resolved === resolveProjectId(null)) {
    // Only global.
    return eq(schema.longTermMemories.projectId, resolved);
  }
  // Project + global.
  return inArray(schema.longTermMemories.projectId, [
    resolved,
    resolveProjectId(null),
  ]);
}

function escapeLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

export async function createLongTermMemoryRow(
  content: string,
  options?: {
    memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
    importance?: number;
    userId?: string;
    key?: string;
    projectId?: string | null;
    dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
    dreamMeta?: Record<string, unknown>;
  },
) {
  // Delegate to the bulk path so both write routes share a single field
  // mapping + default-resolution code path (Repository pattern, AionCore
  // §2). Avoids drift between the single-row and bulk insert shapes.
  const [row] = await createLongTermMemoryRows([
    {
      content,
      memoryType: options?.memoryType,
      importance: options?.importance,
      userId: options?.userId,
      key: options?.key,
      projectId: options?.projectId,
      dreamStatus: options?.dreamStatus,
      dreamMeta: options?.dreamMeta,
    },
  ]);
  return row;
}

/**
 * Bulk-insert long-term memory rows. Used by the agentd webhook that
 * receives multiple memories at once (POST /api/agentd/v1/memories) so the
 * route handler doesn't reach into drizzle directly — keeps the DAL the
 * single owner of the longTermMemories table (Repository pattern, AionCore
 * §2). Empty input is a no-op.
 */
export async function createLongTermMemoryRows(
  rows: Array<{
    content: string;
    memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
    importance?: number;
    userId?: string;
    key?: string;
    projectId?: string | null;
    dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
    dreamMeta?: Record<string, unknown>;
  }>,
) {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(schema.longTermMemories)
    .values(
      rows.map((r) => ({
        content: r.content,
        userId: r.userId ?? 'system',
        // Always store the resolved sentinel for global memories — see
        // lib/memory/scope.ts for why NULL is forbidden.
        projectId: resolveProjectId(r.projectId),
        memoryType: r.memoryType ?? 'fact',
        importance: r.importance ?? 5,
        ...(r.key ? { key: r.key } : {}),
        dreamStatus: r.dreamStatus ?? 'active',
        ...(r.dreamMeta ? { dreamMeta: r.dreamMeta } : {}),
      })),
    )
    .returning();
  return inserted;
}

/**
 * Upsert a long-term memory by (userId, key).
 *
 * Used by the memory extractor: it always knows the semantic key for a
 * fact (e.g. "user.location", "project.tech_stack") and wants to either
 * create a new row or update the content of an existing one. Manual
 * writes (UI / writeMemory tool) leave key=null and use createLongTermMemoryRow.
 *
 * Behavior:
 * - key is null/empty → falls back to createLongTermMemoryRow (no upsert)
 * - row with matching (userId, key) exists → updates content/type/importance
 * - otherwise → inserts a new row
 *
 * Returns the row and whether it was created (vs updated).
 */
export async function upsertLongTermMemoryByKey(input: {
  userId: string;
  key: string;
  content: string;
  memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
  importance?: number;
  projectId?: string | null;
  /**
   * Dream lifecycle state for the written row. Default 'active'.
   * Pass 'tentative' for Phase 2 proposals so recall excludes them
   * until ratified.
   */
  dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
  /**
   * Optional Dream metadata (confidence / source_kind / provenance).
   * Replaces the row's dream_meta jsonb on update.
   */
  dreamMeta?: Record<string, unknown>;
}): Promise<{
  row: Awaited<ReturnType<typeof createLongTermMemoryRow>>;
  created: boolean;
}> {
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    // Empty key → fall back to createLongTermMemoryRow. Preserve the
    // Dream lifecycle fields (status + meta) so a tentative proposal
    // written under an empty key still lands as tentative, and its
    // provenance survives. Earlier code dropped both fields here.
    const row = await createLongTermMemoryRow(input.content, {
      userId: input.userId,
      memoryType: input.memoryType,
      importance: input.importance,
      projectId: input.projectId,
      dreamStatus: input.dreamStatus,
      dreamMeta: input.dreamMeta,
    });
    return { row, created: true };
  }

  const resolvedProjectId = resolveProjectId(input.projectId);

  const [existing] = await db
    .select({ id: schema.longTermMemories.id })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.projectId, resolvedProjectId),
        eq(schema.longTermMemories.key, trimmedKey),
      ),
    )
    .limit(1);

  if (existing) {
    // Only flip dream_status when the caller EXPLICITLY provided one.
    // Defaulting to 'active' here would silently promote a tentative
    // (or re-activate a superseded) row just because an unrelated
    // content refresh omitted the field. Creation paths still default
    // to 'active' via createLongTermMemoryRow.
    const [row] = await db
      .update(schema.longTermMemories)
      .set({
        content: input.content,
        memoryType: input.memoryType ?? 'fact',
        importance: input.importance ?? 5,
        updatedAt: new Date(),
        // Conditionally include dream_status only when explicitly provided,
        // so an omitted field preserves the stored status. Spread `false`
        // for the unused branch so the object literal stays a plain object.
        ...(input.dreamStatus !== undefined
          ? { dreamStatus: input.dreamStatus }
          : {}),
        ...(input.dreamMeta ? { dreamMeta: input.dreamMeta } : {}),
      })
      .where(eq(schema.longTermMemories.id, existing.id))
      .returning();
    return { row, created: false };
  }

  const row = await createLongTermMemoryRow(input.content, {
    userId: input.userId,
    memoryType: input.memoryType,
    importance: input.importance,
    key: trimmedKey,
    projectId: input.projectId,
    dreamStatus: input.dreamStatus,
    dreamMeta: input.dreamMeta,
  });
  return { row, created: true };
}

export async function getLongTermMemoryRow(
  id: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .select()
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

export async function listLongTermMemoryRows(options?: {
  limit?: number;
  offset?: number;
  userId?: string;
  projectIdScope?: string | null;
  /**
   * When true, include tentative/superseded/contradicted rows. Default
   * false so recall + UI only see active memories. Dream is the main
   * caller that passes true (it needs the full set to consolidate).
   */
  includeInactive?: boolean;
}) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 100, 200));
  const safeOffset = Math.max(0, options?.offset ?? 0);

  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }
  const scopeCondition = buildProjectScopeCondition(options?.projectIdScope);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }
  if (!options?.includeInactive) {
    conditions.push(eq(schema.longTermMemories.dreamStatus, 'active'));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt))
    .limit(safeLimit)
    .offset(safeOffset);
}

export async function listAllLongTermMemoryRows(options?: {
  userId?: string;
  projectIdScope?: string | null;
  /**
   * When true, include tentative/superseded/contradicted rows. Default
   * false. Dream phase1/2 pass false (they consolidate active rows
   * only); admin / audit callers pass true to see the full lifecycle.
   */
  includeInactive?: boolean;
}) {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }
  const scopeCondition = buildProjectScopeCondition(options?.projectIdScope);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }
  if (!options?.includeInactive) {
    conditions.push(eq(schema.longTermMemories.dreamStatus, 'active'));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt));
}

/**
 * List distinct userIds that own long-term memories. Used by the Dream
 * orchestrator's nightly fan-out: it needs to run once per user that has
 * memories to consolidate, without pulling a full table scan into JS.
 *
 * Excludes the 'system' sentinel user — Dream is a per-developer feature
 * and 'system' rows are shared/global facts that don't belong to a single
 * user's consolidation pass.
 */
export async function listDistinctLongTermMemoryUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: schema.longTermMemories.userId })
    .from(schema.longTermMemories)
    .where(
      and(
        isNotNull(schema.longTermMemories.userId),
        ne(schema.longTermMemories.userId, 'system'),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}

export async function countLongTermMemoriesByUserIds(userIds: string[]) {
  const ids = [...new Set(userIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) {
    return new Map<string, number>();
  }

  const rows = await db
    .select({
      userId: schema.longTermMemories.userId,
      count: count(),
    })
    .from(schema.longTermMemories)
    .where(inArray(schema.longTermMemories.userId, ids))
    .groupBy(schema.longTermMemories.userId);

  return new Map(
    rows
      .filter((row): row is { userId: string; count: number } =>
        Boolean(row.userId),
      )
      .map((row) => [row.userId, Number(row.count)]),
  );
}

export async function updateLongTermMemoryRow(
  id: string,
  content: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .update(schema.longTermMemories)
    .set({ content, updatedAt: new Date() })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

export async function deleteLongTermMemoryRow(
  id: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.longTermMemories.id, id)];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  const [row] = await db
    .delete(schema.longTermMemories)
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Delete a long-term memory row by (userId, key).
 *
 * Used by the memory extractor's DELETE action: when the LLM decides a
 * previously-stored fact is wrong/outdated, it emits the existing key
 * with action=DELETE. Returns the deleted row (or null if no match).
 */
export async function deleteLongTermMemoryByKey(input: {
  userId: string;
  key: string;
  projectId?: string | null;
}) {
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    return null;
  }

  const [row] = await db
    .delete(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(
          schema.longTermMemories.projectId,
          resolveProjectId(input.projectId),
        ),
        eq(schema.longTermMemories.key, trimmedKey),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * Mark a memory as superseded by a newer canonical fact, without deleting
 * it. Used by Dream Phase 1 consolidation (CONSOLIDATE op) and by direct
 * SUPERSEDE ops — replaces the old delete-based behavior so the audit
 * trail (original content + when it was retired) survives for review.
 *
 * The optional `supersededBy` id is recorded in `dream_meta.provenance`
 * so a reviewer can trace from a retired memory forward to its
 * replacement. Recall excludes superseded rows via the partial index on
 * `dream_status = 'active'`.
 *
 * Returns the updated row (or null if the id doesn't exist / belongs to
 * another user).
 */
export async function markLongTermMemorySuperseded(input: {
  id: string;
  userId?: string;
  /**
   * Optional id of the memory that replaces this one. Recorded as
   * provenance for forward-tracing.
   */
  supersededBy?: string;
  /**
   * Optional Dream run id that triggered the supersede, for audit.
   */
  dreamRunId?: string;
}) {
  const conditions = [eq(schema.longTermMemories.id, input.id)];
  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  // Read the current row first so we can DEEP-MERGE provenance into the
  // existing dream_meta rather than overwriting the whole column. Earlier
  // code did `dreamMeta: { provenance: {...}, lastDreamAt }` which wiped
  // any previously-recorded confidence / sourceKind / earlier provenance.
  const [existing] = await db
    .select({ dreamMeta: schema.longTermMemories.dreamMeta })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);
  const prevMeta =
    (existing?.dreamMeta as Record<string, unknown> | null) ?? {};
  const prevProvenance =
    (prevMeta.provenance as Record<string, unknown> | undefined) ?? {};

  const [row] = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: 'superseded',
      updatedAt: new Date(),
      dreamMeta: {
        ...prevMeta,
        provenance: {
          ...prevProvenance,
          ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
          ...(input.dreamRunId ? { dreamRunId: input.dreamRunId } : {}),
        },
        lastDreamAt: new Date().toISOString(),
      },
    })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Promote a tentative Dream proposal to active so it joins recall.
 *
 * Called by the ratification pass (auto or manual): Dream Phase 2 writes
 * proposals with dream_status='tentative'; this flips them to 'active'
 * once ratified. Optionally down-ranks (demote to 'contradicted') when
 * a reviewer rejects the proposal — `rejected=true` records the rejection
 * in dream_meta without deleting the row (so the proposal isn't
 * re-proposed next run).
 */
export async function ratifyLongTermMemory(input: {
  id: string;
  userId?: string;
  /**
   * true = ratify (tentative → active). false = reject (tentative →
   * contradicted, recorded so Dream won't re-propose the same finding).
   */
  ratified: boolean;
  /**
   * Optional reviewer note recorded in dream_meta for audit.
   */
  note?: string;
}) {
  const conditions = [
    eq(schema.longTermMemories.id, input.id),
    eq(schema.longTermMemories.dreamStatus, 'tentative'),
  ];
  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  // Read the current row so we can merge into the existing dream_meta
  // (preserving confidence / sourceKind / provenance from the original
  // proposal) instead of overwriting it with just the ratification fields.
  const [existing] = await db
    .select({ dreamMeta: schema.longTermMemories.dreamMeta })
    .from(schema.longTermMemories)
    .where(and(...conditions))
    .limit(1);
  const prevMeta =
    (existing?.dreamMeta as Record<string, unknown> | null) ?? {};

  const [row] = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: input.ratified ? 'active' : 'contradicted',
      updatedAt: new Date(),
      dreamMeta: {
        ...prevMeta,
        ratifiedAt: new Date().toISOString(),
        ratified: input.ratified,
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    })
    .where(and(...conditions))
    .returning();

  return row ?? null;
}

/**
 * Bulk-set the dream_status of ALL of a user's tentative proposals in one
 * UPDATE — used by the ratify-all / reject-all handler so a 50-proposal
 * review queue is one round-trip, not 50.
 *
 * Scoped to (userId, dream_status='tentative') so it can only promote/demote
 * pending proposals, never touch active/superseded rows. Merges the
 * ratification fields into existing dream_meta at the SQL level (jsonb ||).
 *
 * @returns the number of rows actually updated (0 if none were tentative).
 */
export async function bulkSetTentativeStatus(input: {
  userId: string;
  /** true → promote to 'active'; false → demote to 'contradicted'. */
  ratified: boolean;
}): Promise<number> {
  const updated = await db
    .update(schema.longTermMemories)
    .set({
      dreamStatus: input.ratified ? 'active' : 'contradicted',
      updatedAt: new Date(),
      // Merge ratification fields into whatever dream_meta each row already
      // carries — coalesce to '{}' so legacy rows (null meta) aren't nulled
      // out. jsonb || merges top-level keys per row.
      dreamMeta: sql`coalesce(${schema.longTermMemories.dreamMeta}, '{}'::jsonb) || ${JSON.stringify(
        {
          ratifiedAt: new Date().toISOString(),
          ratified: input.ratified,
        },
      )}::jsonb`,
    })
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .returning({ id: schema.longTermMemories.id });
  return updated.length;
}
export async function listTentativeMemories(input: {
  userId: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return db
    .select()
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
      ),
    )
    .orderBy(desc(schema.longTermMemories.updatedAt))
    .limit(limit);
}

/**
 * List distinct userIds that own tentative Dream proposals. Used by
 * the auto-ratify cron to fan out across users without scanning every
 * row in JS. Symmetric to listDistinctLongTermMemoryUserIds but
 * filtered to dream_status='tentative' so we only touch users who
 * actually have proposals pending review.
 */
export async function listDistinctTentativeUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: schema.longTermMemories.userId })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.dreamStatus, 'tentative'),
        isNotNull(schema.longTermMemories.userId),
        ne(schema.longTermMemories.userId, 'system'),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}

export async function replaceLongTermMemoryChunks(
  memoryId: string,
  chunks: LongTermChunkInput[],
) {
  if (chunks.length === 0) {
    return;
  }

  logger.info('replace_chunks:start', {
    memoryId,
    chunkCount: chunks.length,
    embeddedChunkCount: chunks.filter(
      (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0,
    ).length,
    embeddingModels: [...new Set(chunks.map((chunk) => chunk.embeddingModel))],
    embeddingDimensions: [
      ...new Set(chunks.map((chunk) => chunk.embeddingDimensions ?? null)),
    ],
  });

  await db.batch([
    db
      .delete(schema.longTermMemoryChunks)
      .where(eq(schema.longTermMemoryChunks.memoryId, memoryId)),
    db.insert(schema.longTermMemoryChunks).values(
      chunks.map((chunk) => ({
        memoryId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding ?? null,
        embeddingModel: chunk.embeddingModel ?? null,
        embeddingDimensions:
          chunk.embeddingDimensions ?? chunk.embedding?.length ?? null,
        tsv: sql`to_tsvector('simple', ${chunk.content})`,
      })),
    ),
  ]);

  logger.info('replace_chunks:success', {
    memoryId,
    chunkCount: chunks.length,
  });
}

export async function listLongTermMemoryChunksForMemory(memoryId: string) {
  return db
    .select()
    .from(schema.longTermMemoryChunks)
    .where(eq(schema.longTermMemoryChunks.memoryId, memoryId))
    .orderBy(schema.longTermMemoryChunks.chunkIndex);
}

async function listKeywordCandidateRows(options: {
  searchText: string;
  candidateLimit: number;
  userId?: string;
  projectIdScope?: string | null;
}) {
  const normalizedSearchText = options.searchText.trim();
  const likePattern = `%${escapeLikePattern(normalizedSearchText)}%`;
  const useSubstringFallback = containsCjk(normalizedSearchText);
  const { userId } = options;

  const userIdCondition = userId
    ? eq(schema.longTermMemories.userId, userId)
    : undefined;
  const scopeCondition = buildProjectScopeCondition(options.projectIdScope);
  // Recall excludes non-active Dream rows (tentative proposals +
  // superseded sources + contradicted). Because recall is always
  // per-user, needsJoin is always true in practice — but we defensively
  // force the join when this condition is present so the filter can't
  // be silently dropped on a future caller that passes neither userId
  // nor scope.
  const activeStatusCondition = eq(
    schema.longTermMemories.dreamStatus,
    'active',
  );
  // projectId scope lives on long_term_memories, so any scope filter forces
  // the join even when the caller didn't pass a userId (otherwise the
  // un-joined query would silently ignore the scope and leak cross-project
  // memories into recall).
  const needsJoin =
    Boolean(userId) ||
    Boolean(scopeCondition) ||
    Boolean(activeStatusCondition);

  const baseSelect = {
    chunkId: schema.longTermMemoryChunks.id,
    memoryId: schema.longTermMemoryChunks.memoryId,
    content: schema.longTermMemoryChunks.content,
  };

  const tsQueryExpr = sql`websearch_to_tsquery('simple', ${normalizedSearchText})`;
  const keywordScoreExpr = sql<number>`coalesce(ts_rank(${schema.longTermMemoryChunks.tsv}, ${tsQueryExpr}, 32), 0)`;
  const substringScoreExpr = sql<number>`case when ${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\' then 1 else 0 end`;

  const joinMemories = <T extends Parameters<typeof db.select>[0]>(
    selectCols: T,
  ) => {
    const base = db.select(selectCols).from(schema.longTermMemoryChunks);
    return needsJoin
      ? base.innerJoin(
          schema.longTermMemories,
          eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
        )
      : base;
  };

  if (useSubstringFallback) {
    return joinMemories({ ...baseSelect, keywordScore: substringScoreExpr })
      .where(
        and(
          sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
          userIdCondition,
          scopeCondition,
          activeStatusCondition,
        ),
      )
      .orderBy(
        sql`${substringScoreExpr} DESC`,
        desc(schema.longTermMemoryChunks.createdAt),
      )
      .limit(options.candidateLimit);
  }

  const mainRows = await joinMemories({
    ...baseSelect,
    keywordScore: keywordScoreExpr,
  })
    .where(
      and(
        sql`${schema.longTermMemoryChunks.tsv} @@ ${tsQueryExpr}`,
        userIdCondition,
        scopeCondition,
        activeStatusCondition,
      ),
    )
    .orderBy(sql`${keywordScoreExpr} DESC`)
    .limit(options.candidateLimit);

  if (mainRows.length > 0) {
    return mainRows;
  }

  return joinMemories({ ...baseSelect, keywordScore: substringScoreExpr })
    .where(
      and(
        sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
        userIdCondition,
        scopeCondition,
        activeStatusCondition,
      ),
    )
    .orderBy(
      sql`${substringScoreExpr} DESC`,
      desc(schema.longTermMemoryChunks.createdAt),
    )
    .limit(options.candidateLimit);
}

export async function hybridSearchLongTermMemoryChunks(options: {
  queryEmbedding?: number[];
  queryEmbeddingModel?: string;
  queryEmbeddingDimensions?: number;
  searchText?: string;
  minConfidence: number;
  limit: number;
  offset: number;
  userId?: string;
  projectIdScope?: string | null;
}): Promise<HybridSearchRow[]> {
  const {
    queryEmbedding,
    queryEmbeddingModel,
    queryEmbeddingDimensions,
    searchText,
    minConfidence,
    limit,
    offset,
    userId,
    projectIdScope,
  } = options;

  const hasEmbedding = queryEmbedding && queryEmbedding.length > 0;
  const vectorDimensions = queryEmbeddingDimensions ?? queryEmbedding?.length;
  const canRunVectorSearch =
    hasEmbedding &&
    typeof queryEmbeddingModel === 'string' &&
    queryEmbeddingModel.length > 0 &&
    typeof vectorDimensions === 'number';
  const normalizedSearchText = searchText?.trim() || '';
  const hasTextSearch = normalizedSearchText.length > 0;
  const candidateLimit = getHybridCandidateLimit({ limit, offset });

  logger.info('hybrid_search:start', {
    hasEmbedding,
    hasTextSearch,
    searchTextPreview: buildSearchTextPreview(normalizedSearchText),
    queryEmbeddingModel: queryEmbeddingModel ?? null,
    queryEmbeddingDimensions: vectorDimensions ?? null,
    minConfidence,
    limit,
    offset,
    candidateLimit,
  });

  if (!hasEmbedding && !hasTextSearch) {
    logger.info('hybrid_search:empty_input');
    return [];
  }

  if (!hasEmbedding && hasTextSearch) {
    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:keyword_only', {
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  if (!canRunVectorSearch) {
    if (!hasTextSearch) {
      return [];
    }

    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:fallback_keyword_only', {
      reason: 'vector_search_not_available',
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const activeQueryEmbedding = queryEmbedding;
  const activeEmbeddingModel = queryEmbeddingModel;
  const activeVectorDimensions = vectorDimensions;

  if (
    !activeQueryEmbedding ||
    activeQueryEmbedding.length === 0 ||
    typeof activeEmbeddingModel !== 'string' ||
    activeEmbeddingModel.length === 0 ||
    typeof activeVectorDimensions !== 'number'
  ) {
    if (!hasTextSearch) {
      return [];
    }

    const keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      userId,
      projectIdScope,
    });
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence,
      limit,
      offset,
    });

    logger.warn('hybrid_search:fallback_keyword_only', {
      reason: 'vector_inputs_incomplete_after_guard',
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const distanceExpr = cosineDistance(
    schema.longTermMemoryChunks.embedding,
    activeQueryEmbedding,
  );
  const vectorScoreExpr = sql<number>`greatest(0, 1 - (${distanceExpr}))`;
  const vectorRows = await db
    .select({
      chunkId: schema.longTermMemoryChunks.id,
      memoryId: schema.longTermMemoryChunks.memoryId,
      content: schema.longTermMemoryChunks.content,
      vectorScore: vectorScoreExpr,
      importance: schema.longTermMemories.importance,
      lastAccessedAt: schema.longTermMemoryChunks.lastAccessedAt,
    })
    .from(schema.longTermMemoryChunks)
    .innerJoin(
      schema.longTermMemories,
      eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
    )
    .where(
      and(
        sql`${schema.longTermMemoryChunks.embedding} IS NOT NULL`,
        eq(schema.longTermMemoryChunks.embeddingModel, activeEmbeddingModel),
        eq(
          schema.longTermMemoryChunks.embeddingDimensions,
          activeVectorDimensions,
        ),
        userId ? eq(schema.longTermMemories.userId, userId) : undefined,
        buildProjectScopeCondition(projectIdScope),
        eq(schema.longTermMemories.dreamStatus, 'active'),
      ),
    )
    .orderBy(sql`${vectorScoreExpr} DESC`)
    .limit(candidateLimit);

  logger.info('hybrid_search:vector_candidates', {
    queryEmbeddingModel: activeEmbeddingModel,
    queryEmbeddingDimensions: activeVectorDimensions,
    vectorCandidateCount: vectorRows.length,
    topVectorCandidates: vectorRows.slice(0, 5).map((row) => ({
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      vectorScore: roundScore(row.vectorScore),
    })),
  });

  if (!hasTextSearch) {
    const mergedRows = mergeHybridSearchCandidates({
      vectorRows,
      keywordRows: [],
      minConfidence,
      limit,
      offset,
    });

    logger.info('hybrid_search:vector_only', {
      vectorCandidateCount: vectorRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    });

    return mergedRows;
  }

  const keywordRows = await listKeywordCandidateRows({
    searchText: normalizedSearchText,
    candidateLimit,
    userId,
    projectIdScope,
  });

  logger.info('hybrid_search:keyword_candidates', {
    keywordCandidateCount: keywordRows.length,
    topKeywordCandidates: keywordRows.slice(0, 5).map((row) => ({
      chunkId: row.chunkId,
      memoryId: row.memoryId,
      keywordScore: roundScore(row.keywordScore),
    })),
  });

  const mergedRows = mergeHybridSearchCandidates({
    vectorRows,
    keywordRows,
    minConfidence,
    limit,
    offset,
  });

  logger.info(
    vectorRows.length === 0
      ? 'hybrid_search:hybrid_no_vector_hits'
      : 'hybrid_search:hybrid_result',
    {
      vectorCandidateCount: vectorRows.length,
      keywordCandidateCount: keywordRows.length,
      resultCount: mergedRows.length,
      topResults: summarizeHybridRows(mergedRows),
    },
  );

  return mergedRows;
}

export async function updateLastAccessedAt(chunkIds: string[]) {
  if (chunkIds.length === 0) {
    return;
  }

  await db
    .update(schema.longTermMemoryChunks)
    .set({ lastAccessedAt: new Date() })
    .where(inArray(schema.longTermMemoryChunks.id, chunkIds));
}
