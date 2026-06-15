import { createHash } from 'node:crypto';

import { db, schema } from '@/lib/core/db';
import { getHybridCandidateLimit } from '@/lib/memory/search';
import { createLogger } from '@/lib/utils/logger';
import { and, cosineDistance, desc, eq, inArray, or, sql } from 'drizzle-orm';

const logger = createLogger('db.knowledge');
const RRF_K = 60;

export type KnowledgeBaseRow = typeof schema.knowledgeBases.$inferSelect;
export type KnowledgeConnectorRow =
  typeof schema.knowledgeConnectors.$inferSelect;
export type KnowledgeDocumentRow =
  typeof schema.knowledgeDocuments.$inferSelect;
export type KnowledgeVisibility = 'team' | 'private';
export type KnowledgeAccessScope = {
  userId?: string | null;
  isAdmin?: boolean;
};

export type KnowledgeChunkInput = {
  chunkIndex: number;
  content: string;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
};

export type KnowledgeSearchRow = {
  chunkId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBasePriority: number;
  knowledgeBaseVisibility: KnowledgeVisibility;
  documentId: string;
  documentTitle: string;
  documentSourceType: 'text' | 'file' | 'url' | 'import';
  documentSourceUri: string | null;
  documentCreatedAt: Date;
  content: string;
  vectorScore: number;
  keywordScore: number;
  finalScore: number;
};

export type SearchCandidate = Omit<KnowledgeSearchRow, 'finalScore'>;

function containsCjk(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(value);
}

function escapeLikePattern(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

export function mergeKnowledgeCandidates(input: {
  vectorRows: SearchCandidate[];
  keywordRows: SearchCandidate[];
  remoteRows?: SearchCandidate[];
  minConfidence: number;
  limit: number;
  offset: number;
}): KnowledgeSearchRow[] {
  const merged = new Map<
    string,
    SearchCandidate & {
      rrfScore: number;
    }
  >();

  for (const [rank, row] of input.vectorRows.entries()) {
    merged.set(row.chunkId, {
      ...row,
      keywordScore: 0,
      rrfScore: 1 / (RRF_K + rank + 1),
    });
  }

  for (const [rank, row] of input.keywordRows.entries()) {
    const existing = merged.get(row.chunkId);
    if (existing) {
      existing.keywordScore = row.keywordScore;
      existing.rrfScore += 1 / (RRF_K + rank + 1);
      continue;
    }

    merged.set(row.chunkId, {
      ...row,
      vectorScore: 0,
      rrfScore: 1 / (RRF_K + rank + 1),
    });
  }

  for (const [rank, row] of (input.remoteRows ?? []).entries()) {
    const existing = merged.get(row.chunkId);
    if (existing) {
      existing.rrfScore += 1 / (RRF_K + rank + 1);
      continue;
    }

    merged.set(row.chunkId, {
      ...row,
      rrfScore: 1 / (RRF_K + rank + 1),
    });
  }

  return Array.from(merged.values())
    .map((row) => ({
      chunkId: row.chunkId,
      knowledgeBaseId: row.knowledgeBaseId,
      knowledgeBaseName: row.knowledgeBaseName,
      knowledgeBasePriority: row.knowledgeBasePriority,
      knowledgeBaseVisibility: row.knowledgeBaseVisibility,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      documentSourceType: row.documentSourceType,
      documentSourceUri: row.documentSourceUri,
      documentCreatedAt: row.documentCreatedAt,
      content: row.content,
      vectorScore: row.vectorScore,
      keywordScore: row.keywordScore,
      finalScore: row.rrfScore,
    }))
    .filter((row) => row.finalScore >= input.minConfidence)
    .sort((left, right) => {
      if (right.finalScore !== left.finalScore) {
        return right.finalScore - left.finalScore;
      }
      if (right.knowledgeBasePriority !== left.knowledgeBasePriority) {
        return right.knowledgeBasePriority - left.knowledgeBasePriority;
      }
      if (right.vectorScore !== left.vectorScore) {
        return right.vectorScore - left.vectorScore;
      }
      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }
      return left.chunkId.localeCompare(right.chunkId);
    })
    .slice(input.offset, input.offset + input.limit);
}

function normalizeKnowledgeBaseNames(names?: string[]) {
  return [
    ...new Set(
      (names ?? [])
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];
}

function normalizeIds(ids?: string[]) {
  return [
    ...new Set(
      (ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ];
}

function buildAgentScopeCondition(agentId?: string) {
  if (!agentId || agentId === 'global') {
    return eq(schema.knowledgeBases.agentId, 'global');
  }

  return or(
    eq(schema.knowledgeBases.agentId, 'global'),
    eq(schema.knowledgeBases.agentId, agentId),
  );
}

function buildKnowledgeAccessCondition(
  access?: KnowledgeAccessScope,
  options?: { includeAllPrivate?: boolean },
) {
  if (access?.isAdmin && options?.includeAllPrivate) {
    return undefined;
  }

  const teamCondition = eq(schema.knowledgeBases.visibility, 'team');
  const userId = access?.userId?.trim();
  if (!userId) {
    return teamCondition;
  }

  return or(
    teamCondition,
    and(
      eq(schema.knowledgeBases.visibility, 'private'),
      eq(schema.knowledgeBases.ownerUserId, userId),
    ),
  );
}

export function canManageKnowledgeBaseRow(
  knowledgeBase: Pick<KnowledgeBaseRow, 'visibility' | 'ownerUserId'>,
  access: KnowledgeAccessScope,
) {
  if (access.isAdmin) {
    return true;
  }

  return (
    knowledgeBase.visibility === 'private' &&
    Boolean(access.userId) &&
    knowledgeBase.ownerUserId === access.userId
  );
}

export function hashKnowledgeContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export async function createKnowledgeBaseRow(input: {
  agentId?: string;
  ownerUserId?: string | null;
  visibility?: KnowledgeVisibility;
  kind?: 'local' | 'remote';
  name: string;
  description?: string | null;
  emoji?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  chunkSize?: number;
  chunkOverlap?: number;
  priority?: number;
}) {
  const visibility = input.visibility ?? 'team';
  if (visibility === 'private' && !input.ownerUserId) {
    throw new Error('owner_user_id is required for private knowledge base');
  }

  const [row] = await db
    .insert(schema.knowledgeBases)
    .values({
      agentId: input.agentId ?? 'global',
      ownerUserId:
        visibility === 'private' ? (input.ownerUserId ?? null) : null,
      visibility,
      kind: input.kind ?? 'local',
      name: input.name,
      description: input.description ?? null,
      emoji: input.emoji ?? 'book',
      embeddingModel: input.embeddingModel ?? null,
      embeddingDimensions: input.embeddingDimensions ?? null,
      chunkSize: input.chunkSize ?? 1000,
      chunkOverlap: input.chunkOverlap ?? 120,
      priority: input.priority ?? 0,
    })
    .returning();

  return row;
}

export async function updateKnowledgeBasePriorityRow(input: {
  id: string;
  priority: number;
}) {
  const [row] = await db
    .update(schema.knowledgeBases)
    .set({
      priority: input.priority,
      updatedAt: new Date(),
    })
    .where(eq(schema.knowledgeBases.id, input.id))
    .returning();

  return row ?? null;
}

export async function listKnowledgeBaseRows(options?: {
  agentId?: string;
  includeDisabled?: boolean;
  access?: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const conditions = [
    options?.agentId ? buildAgentScopeCondition(options.agentId) : undefined,
    buildKnowledgeAccessCondition(options?.access, {
      includeAllPrivate: options?.includeAllPrivate,
    }),
    options?.includeDisabled
      ? undefined
      : eq(schema.knowledgeBases.enabled, true),
  ];

  return db
    .select()
    .from(schema.knowledgeBases)
    .where(and(...conditions))
    .orderBy(desc(schema.knowledgeBases.updatedAt));
}

export async function getKnowledgeBaseRow(
  id: string,
  options?: {
    agentId?: string;
    access?: KnowledgeAccessScope;
    includeAllPrivate?: boolean;
  },
) {
  const conditions = [
    eq(schema.knowledgeBases.id, id),
    options?.agentId ? buildAgentScopeCondition(options.agentId) : undefined,
    buildKnowledgeAccessCondition(options?.access, {
      includeAllPrivate: options?.includeAllPrivate,
    }),
  ];

  const [row] = await db
    .select()
    .from(schema.knowledgeBases)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

export async function resolveKnowledgeBaseRows(input: {
  agentId?: string;
  knowledgeBaseIds?: string[];
  knowledgeBaseNames?: string[];
  access?: KnowledgeAccessScope;
}) {
  const ids = normalizeIds(input.knowledgeBaseIds);
  const names = normalizeKnowledgeBaseNames(input.knowledgeBaseNames);

  const conditions = [
    eq(schema.knowledgeBases.enabled, true),
    input.agentId ? buildAgentScopeCondition(input.agentId) : undefined,
    buildKnowledgeAccessCondition(input.access),
    ids.length > 0 ? inArray(schema.knowledgeBases.id, ids) : undefined,
    names.length > 0 ? inArray(schema.knowledgeBases.name, names) : undefined,
  ];

  return db
    .select()
    .from(schema.knowledgeBases)
    .where(and(...conditions))
    .orderBy(desc(schema.knowledgeBases.updatedAt));
}

export async function createKnowledgeDocumentRow(input: {
  knowledgeBaseId: string;
  title: string;
  sourceType?: 'text' | 'file' | 'url' | 'import';
  sourceUri?: string | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const [row] = await db
    .insert(schema.knowledgeDocuments)
    .values({
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title,
      sourceType: input.sourceType ?? 'text',
      sourceUri: input.sourceUri ?? null,
      contentHash: input.contentHash ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();

  return row;
}

export async function listKnowledgeDocumentRows(knowledgeBaseId: string) {
  return db
    .select()
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.knowledgeBaseId, knowledgeBaseId))
    .orderBy(desc(schema.knowledgeDocuments.createdAt));
}

export async function deleteKnowledgeBaseRow(id: string) {
  const [row] = await db
    .delete(schema.knowledgeBases)
    .where(eq(schema.knowledgeBases.id, id))
    .returning();

  return row ?? null;
}

export async function deleteKnowledgeDocumentRow(input: {
  knowledgeBaseId: string;
  documentId: string;
}) {
  const [row] = await db
    .delete(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.id, input.documentId),
        eq(schema.knowledgeDocuments.knowledgeBaseId, input.knowledgeBaseId),
      ),
    )
    .returning();

  return row ?? null;
}

export async function listKnowledgeConnectorRows(knowledgeBaseId: string) {
  return db
    .select()
    .from(schema.knowledgeConnectors)
    .where(eq(schema.knowledgeConnectors.knowledgeBaseId, knowledgeBaseId))
    .orderBy(desc(schema.knowledgeConnectors.createdAt));
}

export async function getKnowledgeConnectorRow(input: {
  knowledgeBaseId: string;
  connectorId: string;
}) {
  const [row] = await db
    .select()
    .from(schema.knowledgeConnectors)
    .where(
      and(
        eq(schema.knowledgeConnectors.id, input.connectorId),
        eq(schema.knowledgeConnectors.knowledgeBaseId, input.knowledgeBaseId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function createKnowledgeConnectorRow(input: {
  knowledgeBaseId: string;
  provider?: 'url' | 'mem0' | 'http';
  name: string;
  sourceUri: string;
  config?: Record<string, unknown> | null;
}) {
  const [row] = await db
    .insert(schema.knowledgeConnectors)
    .values({
      knowledgeBaseId: input.knowledgeBaseId,
      provider: input.provider ?? 'url',
      name: input.name,
      sourceUri: input.sourceUri,
      config: input.config ?? null,
      syncStatus: 'idle',
    })
    .returning();

  return row;
}

export async function updateKnowledgeConnectorSyncRow(input: {
  connectorId: string;
  status: 'idle' | 'syncing' | 'failed';
  lastDocumentId?: string | null;
  lastError?: string | null;
  lastSyncedAt?: Date | null;
}) {
  const values: {
    syncStatus: 'idle' | 'syncing' | 'failed';
    lastDocumentId?: string | null;
    lastError?: string | null;
    lastSyncedAt?: Date | null;
    updatedAt: Date;
  } = {
    syncStatus: input.status,
    lastError: input.lastError ?? null,
    updatedAt: new Date(),
  };
  if ('lastDocumentId' in input) {
    values.lastDocumentId = input.lastDocumentId;
  }
  if ('lastSyncedAt' in input) {
    values.lastSyncedAt = input.lastSyncedAt;
  }

  const [row] = await db
    .update(schema.knowledgeConnectors)
    .set(values)
    .where(eq(schema.knowledgeConnectors.id, input.connectorId))
    .returning();

  return row ?? null;
}

export async function deleteKnowledgeConnectorRow(input: {
  knowledgeBaseId: string;
  connectorId: string;
}) {
  const [row] = await db
    .delete(schema.knowledgeConnectors)
    .where(
      and(
        eq(schema.knowledgeConnectors.id, input.connectorId),
        eq(schema.knowledgeConnectors.knowledgeBaseId, input.knowledgeBaseId),
      ),
    )
    .returning();

  return row ?? null;
}

export async function replaceKnowledgeDocumentChunks(input: {
  knowledgeBaseId: string;
  documentId: string;
  chunks: KnowledgeChunkInput[];
}) {
  await db
    .delete(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.documentId, input.documentId));

  if (input.chunks.length === 0) {
    return;
  }

  await db.insert(schema.knowledgeChunks).values(
    input.chunks.map((chunk) => ({
      knowledgeBaseId: input.knowledgeBaseId,
      documentId: input.documentId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      embedding: chunk.embedding ?? null,
      embeddingModel: chunk.embeddingModel ?? null,
      embeddingDimensions:
        chunk.embeddingDimensions ?? chunk.embedding?.length ?? null,
      tsv: sql`to_tsvector('simple', ${chunk.content})`,
    })),
  );
}

async function listKeywordCandidateRows(options: {
  searchText: string;
  candidateLimit: number;
  agentId?: string;
  knowledgeBaseIds?: string[];
}) {
  const normalizedSearchText = options.searchText.trim();
  const likePattern = `%${escapeLikePattern(normalizedSearchText)}%`;
  const useSubstringFallback = containsCjk(normalizedSearchText);
  const kbIds = normalizeIds(options.knowledgeBaseIds);
  const kbFilter =
    kbIds.length > 0
      ? inArray(schema.knowledgeChunks.knowledgeBaseId, kbIds)
      : undefined;
  const agentFilter = options.agentId
    ? buildAgentScopeCondition(options.agentId)
    : undefined;
  const enabledFilter = eq(schema.knowledgeBases.enabled, true);

  const baseSelect = {
    chunkId: schema.knowledgeChunks.id,
    knowledgeBaseId: schema.knowledgeChunks.knowledgeBaseId,
    knowledgeBaseName: schema.knowledgeBases.name,
    knowledgeBasePriority: schema.knowledgeBases.priority,
    knowledgeBaseVisibility: schema.knowledgeBases.visibility,
    documentId: schema.knowledgeChunks.documentId,
    documentTitle: schema.knowledgeDocuments.title,
    documentSourceType: schema.knowledgeDocuments.sourceType,
    documentSourceUri: schema.knowledgeDocuments.sourceUri,
    documentCreatedAt: schema.knowledgeDocuments.createdAt,
    content: schema.knowledgeChunks.content,
  };

  const buildSubstringQuery = () => {
    const keywordScoreExpr = sql<number>`case when ${schema.knowledgeChunks.content} ilike ${likePattern} escape '\\' then 1 else 0 end`;

    return db
      .select({
        ...baseSelect,
        vectorScore: sql<number>`0`,
        keywordScore: keywordScoreExpr,
      })
      .from(schema.knowledgeChunks)
      .innerJoin(
        schema.knowledgeBases,
        eq(schema.knowledgeChunks.knowledgeBaseId, schema.knowledgeBases.id),
      )
      .innerJoin(
        schema.knowledgeDocuments,
        eq(schema.knowledgeChunks.documentId, schema.knowledgeDocuments.id),
      )
      .where(
        and(
          sql`${schema.knowledgeChunks.content} ilike ${likePattern} escape '\\'`,
          kbFilter,
          agentFilter,
          enabledFilter,
        ),
      )
      .orderBy(
        sql`${keywordScoreExpr} DESC`,
        desc(schema.knowledgeChunks.createdAt),
      )
      .limit(options.candidateLimit);
  };

  if (useSubstringFallback) {
    return buildSubstringQuery();
  }

  const tsQueryExpr = sql`websearch_to_tsquery('simple', ${normalizedSearchText})`;
  const keywordScoreExpr = sql<number>`coalesce(ts_rank(${schema.knowledgeChunks.tsv}, ${tsQueryExpr}, 32), 0)`;

  const rows = await db
    .select({
      ...baseSelect,
      vectorScore: sql<number>`0`,
      keywordScore: keywordScoreExpr,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(
      schema.knowledgeBases,
      eq(schema.knowledgeChunks.knowledgeBaseId, schema.knowledgeBases.id),
    )
    .innerJoin(
      schema.knowledgeDocuments,
      eq(schema.knowledgeChunks.documentId, schema.knowledgeDocuments.id),
    )
    .where(
      and(
        sql`${schema.knowledgeChunks.tsv} @@ ${tsQueryExpr}`,
        kbFilter,
        agentFilter,
        enabledFilter,
      ),
    )
    .orderBy(sql`${keywordScoreExpr} DESC`)
    .limit(options.candidateLimit);

  if (rows.length > 0) {
    return rows;
  }

  return buildSubstringQuery();
}

export async function hybridSearchKnowledgeChunks(options: {
  queryEmbedding?: number[];
  queryEmbeddingModel?: string;
  queryEmbeddingDimensions?: number;
  searchText?: string;
  minConfidence: number;
  limit: number;
  offset: number;
  agentId?: string;
  knowledgeBaseIds?: string[];
}): Promise<KnowledgeSearchRow[]> {
  const normalizedSearchText = options.searchText?.trim() || '';
  const hasTextSearch = normalizedSearchText.length > 0;
  const hasEmbedding =
    Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0;
  const vectorDimensions =
    options.queryEmbeddingDimensions ?? options.queryEmbedding?.length;
  const canRunVectorSearch =
    hasEmbedding &&
    typeof options.queryEmbeddingModel === 'string' &&
    options.queryEmbeddingModel.length > 0 &&
    typeof vectorDimensions === 'number';
  const candidateLimit = getHybridCandidateLimit({
    limit: options.limit,
    offset: options.offset,
  });
  const kbIds = normalizeIds(options.knowledgeBaseIds);
  const kbFilter =
    kbIds.length > 0
      ? inArray(schema.knowledgeChunks.knowledgeBaseId, kbIds)
      : undefined;
  const agentFilter = options.agentId
    ? buildAgentScopeCondition(options.agentId)
    : undefined;
  const enabledFilter = eq(schema.knowledgeBases.enabled, true);

  logger.info('hybrid_search:start', {
    hasTextSearch,
    hasEmbedding,
    queryEmbeddingModel: options.queryEmbeddingModel ?? null,
    queryEmbeddingDimensions: vectorDimensions ?? null,
    limit: options.limit,
    offset: options.offset,
    candidateLimit,
  });

  if (!hasTextSearch && !hasEmbedding) {
    return [];
  }

  let keywordRows: SearchCandidate[] = [];
  if (hasTextSearch) {
    keywordRows = await listKeywordCandidateRows({
      searchText: normalizedSearchText,
      candidateLimit,
      agentId: options.agentId,
      knowledgeBaseIds: kbIds,
    });
  }

  if (!canRunVectorSearch) {
    return mergeKnowledgeCandidates({
      vectorRows: [],
      keywordRows,
      minConfidence: options.minConfidence,
      limit: options.limit,
      offset: options.offset,
    });
  }

  const distanceExpr = cosineDistance(
    schema.knowledgeChunks.embedding,
    options.queryEmbedding ?? [],
  );
  const vectorScoreExpr = sql<number>`greatest(0, 1 - (${distanceExpr}))`;
  const vectorRows = await db
    .select({
      chunkId: schema.knowledgeChunks.id,
      knowledgeBaseId: schema.knowledgeChunks.knowledgeBaseId,
      knowledgeBaseName: schema.knowledgeBases.name,
      knowledgeBasePriority: schema.knowledgeBases.priority,
      knowledgeBaseVisibility: schema.knowledgeBases.visibility,
      documentId: schema.knowledgeChunks.documentId,
      documentTitle: schema.knowledgeDocuments.title,
      documentSourceType: schema.knowledgeDocuments.sourceType,
      documentSourceUri: schema.knowledgeDocuments.sourceUri,
      documentCreatedAt: schema.knowledgeDocuments.createdAt,
      content: schema.knowledgeChunks.content,
      vectorScore: vectorScoreExpr,
      keywordScore: sql<number>`0`,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(
      schema.knowledgeBases,
      eq(schema.knowledgeChunks.knowledgeBaseId, schema.knowledgeBases.id),
    )
    .innerJoin(
      schema.knowledgeDocuments,
      eq(schema.knowledgeChunks.documentId, schema.knowledgeDocuments.id),
    )
    .where(
      and(
        sql`${schema.knowledgeChunks.embedding} IS NOT NULL`,
        eq(
          schema.knowledgeChunks.embeddingModel,
          options.queryEmbeddingModel ?? '',
        ),
        eq(schema.knowledgeChunks.embeddingDimensions, vectorDimensions ?? 0),
        kbFilter,
        agentFilter,
        enabledFilter,
      ),
    )
    .orderBy(sql`${vectorScoreExpr} DESC`)
    .limit(candidateLimit);

  const rows = mergeKnowledgeCandidates({
    vectorRows,
    keywordRows,
    minConfidence: options.minConfidence,
    limit: options.limit,
    offset: options.offset,
  });

  if (rows.length > 0) {
    await db
      .update(schema.knowledgeChunks)
      .set({ lastAccessedAt: new Date() })
      .where(
        inArray(
          schema.knowledgeChunks.id,
          rows.map((row) => row.chunkId),
        ),
      );
  }

  return rows;
}
