import { db, schema } from '@/lib/core/db';
import {
  type HybridSearchRow,
  getHybridCandidateLimit,
  mergeHybridSearchCandidates,
} from '@/lib/memory/search';
import { createLogger } from '@/lib/utils/logger';
import {
  and,
  cosineDistance,
  count,
  desc,
  eq,
  inArray,
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
  },
) {
  const [row] = await db
    .insert(schema.longTermMemories)
    .values({
      content,
      userId: options?.userId ?? 'system',
      memoryType: options?.memoryType ?? 'fact',
      importance: options?.importance ?? 5,
      ...(options?.key ? { key: options.key } : {}),
    })
    .returning();

  return row;
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
}): Promise<{
  row: Awaited<ReturnType<typeof createLongTermMemoryRow>>;
  created: boolean;
}> {
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    const row = await createLongTermMemoryRow(input.content, {
      userId: input.userId,
      memoryType: input.memoryType,
      importance: input.importance,
    });
    return { row, created: true };
  }

  const [existing] = await db
    .select({ id: schema.longTermMemories.id })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        eq(schema.longTermMemories.key, trimmedKey),
      ),
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(schema.longTermMemories)
      .set({
        content: input.content,
        memoryType: input.memoryType ?? 'fact',
        importance: input.importance ?? 5,
        updatedAt: new Date(),
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
}) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 100, 200));
  const safeOffset = Math.max(0, options?.offset ?? 0);

  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt))
    .limit(safeLimit)
    .offset(safeOffset);
}

export async function listAllLongTermMemoryRows(options?: { userId?: string }) {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.longTermMemories.userId, options.userId));
  }

  return db
    .select()
    .from(schema.longTermMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.longTermMemories.updatedAt));
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
}) {
  const normalizedSearchText = options.searchText.trim();
  const likePattern = `%${escapeLikePattern(normalizedSearchText)}%`;
  const useSubstringFallback = containsCjk(normalizedSearchText);
  const { userId } = options;

  const userIdCondition = userId
    ? eq(schema.longTermMemories.userId, userId)
    : undefined;

  const baseSelect = {
    chunkId: schema.longTermMemoryChunks.id,
    memoryId: schema.longTermMemoryChunks.memoryId,
    content: schema.longTermMemoryChunks.content,
  };

  if (useSubstringFallback) {
    const substringScoreExpr = sql<number>`case when ${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\' then 1 else 0 end`;

    const baseQuery = db
      .select({ ...baseSelect, keywordScore: substringScoreExpr })
      .from(schema.longTermMemoryChunks);

    const query = userId
      ? baseQuery.innerJoin(
          schema.longTermMemories,
          eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
        )
      : baseQuery;

    return query
      .where(
        and(
          sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
          userIdCondition,
        ),
      )
      .orderBy(
        sql`${substringScoreExpr} DESC`,
        desc(schema.longTermMemoryChunks.createdAt),
      )
      .limit(options.candidateLimit);
  }

  const tsQueryExpr = sql`websearch_to_tsquery('simple', ${normalizedSearchText})`;
  const keywordScoreExpr = sql<number>`coalesce(ts_rank(${schema.longTermMemoryChunks.tsv}, ${tsQueryExpr}, 32), 0)`;

  const mainQuery = db
    .select({ ...baseSelect, keywordScore: keywordScoreExpr })
    .from(schema.longTermMemoryChunks);

  const query = userId
    ? mainQuery.innerJoin(
        schema.longTermMemories,
        eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
      )
    : mainQuery;

  const rows = await query
    .where(
      and(
        sql`${schema.longTermMemoryChunks.tsv} @@ ${tsQueryExpr}`,
        userIdCondition,
      ),
    )
    .orderBy(sql`${keywordScoreExpr} DESC`)
    .limit(options.candidateLimit);

  if (rows.length > 0) {
    return rows;
  }

  const substringScoreExpr = sql<number>`case when ${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\' then 1 else 0 end`;

  const fallbackMainQuery = db
    .select({ ...baseSelect, keywordScore: substringScoreExpr })
    .from(schema.longTermMemoryChunks);

  const fallbackQuery = userId
    ? fallbackMainQuery.innerJoin(
        schema.longTermMemories,
        eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
      )
    : fallbackMainQuery;

  return fallbackQuery
    .where(
      and(
        sql`${schema.longTermMemoryChunks.content} ilike ${likePattern} escape '\\'`,
        userIdCondition,
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
