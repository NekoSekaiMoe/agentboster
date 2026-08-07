import { embedMany } from 'ai';

import { generateEmbedding, resolveEmbeddingModel } from '@/lib/ai';
import {
  type LongTermMemorySourceKind,
  createLongTermMemoryRow,
  deleteLongTermMemoryRow,
  getLongTermMemoryRow,
  hybridSearchLongTermMemoryChunks,
  listAllLongTermMemoryRows,
  listLongTermMemoryRows,
  replaceLongTermMemoryChunks,
  updateLastAccessedAt,
  updateLongTermMemoryRow,
  upsertLongTermMemoryByKey,
} from '@/lib/core/db/memory/long-term';
import { getConfig } from '@/lib/core/kv/config';
import {
  type HybridSearchRow,
  buildMemorySearchText,
} from '@/lib/memory/search';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { LongTermMemoryIndexing } from '@/types/memory';
import { deriveEdgesForMemory } from './edges';
import { invalidateProfileCache } from './profile';
import { invalidateRecallCache } from './recall';
import { invalidateTriggerCache } from './triggers';
import { bumpMemoryVersion } from './provider/write-gate';

const logger = createLogger('memory.long_term');

type MemoryChunk = {
  chunkIndex: number;
  content: string;
};

function buildMemoryChunks(content: string): MemoryChunk[] {
  return [{ chunkIndex: 0, content }];
}

async function getEffectiveConfig(config?: AppConfig) {
  return config ?? (await getConfig());
}

async function buildIndexedChunks(input: {
  content: string;
  config: AppConfig;
}): Promise<{
  chunks: Array<
    MemoryChunk & {
      embedding: number[] | null;
      embeddingModel: string | null;
      embeddingDimensions: number | null;
    }
  >;
  indexing: LongTermMemoryIndexing;
}> {
  const chunks = buildMemoryChunks(input.content);
  const embeddingModel = input.config.models?.embedding_model ?? null;

  if (!embeddingModel || chunks.length === 0) {
    return {
      chunks: chunks.map((chunk) => ({
        ...chunk,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      })),
      indexing: {
        mode: 'keyword_only_no_model',
        embeddingModel: null,
        embeddingDimensions: null,
        warning: null,
      },
    };
  }

  try {
    const model = resolveEmbeddingModel(embeddingModel, input.config);
    const { embeddings } = await embedMany({
      model,
      values: chunks.map((chunk) => chunk.content),
    });
    const embeddingDimensions = embeddings[0]?.length ?? null;

    return {
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index] ?? null,
        embeddingModel,
        embeddingDimensions: embeddings[index]?.length ?? null,
      })),
      indexing: {
        mode: 'embedded',
        embeddingModel,
        embeddingDimensions,
        warning: null,
      },
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);

    logger.warn('index:embedding_failed', {
      embeddingModel,
      warning,
    });

    return {
      chunks: chunks.map((chunk) => ({
        ...chunk,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      })),
      indexing: {
        mode: 'keyword_only_embedding_failed',
        embeddingModel,
        embeddingDimensions: null,
        warning,
      },
    };
  }
}

async function indexLongTermMemoryContent(input: {
  memoryId: string;
  content: string;
  config?: AppConfig;
}) {
  const config = await getEffectiveConfig(input.config);
  const { chunks, indexing } = await buildIndexedChunks({
    content: input.content,
    config,
  });

  await replaceLongTermMemoryChunks(input.memoryId, chunks);

  return indexing;
}

export async function createLongTermMemory(input: {
  content: string;
  memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
  importance?: number;
  userId?: string;
  key?: string;
  sourceKind?: LongTermMemorySourceKind;
  triggerPhrases?: string[];
  config?: AppConfig;
}) {
  const memory = await createLongTermMemoryRow(input.content, {
    memoryType: input.memoryType,
    importance: input.importance,
    userId: input.userId,
    key: input.key,
    sourceKind: input.sourceKind,
    triggerPhrases: input.triggerPhrases,
  });
  const indexing = await indexLongTermMemoryContent({
    memoryId: memory.id,
    content: memory.content,
    config: input.config,
  });

  // Invalidate now (content changed) and again once edge derivation finishes.
  // Derivation runs in the background and rewrites the graph; a recall that
  // lands mid-derivation would otherwise rebuild the cache on the stale graph
  // and never be invalidated again. The second invalidation closes that race.
  // Await profile invalidation so the function doesn't return with a stale
  // profile still cached (recall invalidation stays fire-and-forget since it
  // is re-issued after edge derivation anyway).
  invalidateRecallCache(input.userId);
  invalidateTriggerCache(input.userId);
  await invalidateProfileCache(input.userId);
  // reviewer A1:写入成功后必须 bump version(不可被调用方绕过)。
  // 把 bump 收进函数内部,调用方不必记得调失效层也能让 readMemoryVersion 前进。
  if (input.userId) await bumpMemoryVersion(input.userId);
  deriveEdgesForMemory(memory.id, input.config)
    .catch(() => {})
    .finally(() => invalidateRecallCache(input.userId));

  return { memory, indexing };
}

/**
 * Upsert a memory by (userId, key) for the extractor path.
 * Re-indexes chunks when an existing row is updated.
 */
export async function upsertLongTermMemory(input: {
  userId: string;
  key: string;
  content: string;
  memoryType?: 'fact' | 'preference' | 'decision' | 'conversation';
  importance?: number;
  projectId?: string | null;
  sourceKind?: LongTermMemorySourceKind;
  triggerPhrases?: string[];
  /**
   * Dream 生命周期状态。默认 'active'。
   * Dream 提案传 'tentative' 使 recall 在 ratify 前排除。
   * (Phase 1 扩字段:之前 Dream 只能直调 upsertLongTermMemoryByKey。)
   */
  dreamStatus?: 'active' | 'tentative' | 'superseded' | 'contradicted';
  /** Dream 元数据(confidence / provenance / lineage)。 */
  dreamMeta?: Record<string, unknown>;
  config?: AppConfig;
}) {
  const { row: memory, created } = await upsertLongTermMemoryByKey({
    userId: input.userId,
    key: input.key,
    content: input.content,
    memoryType: input.memoryType,
    importance: input.importance,
    projectId: input.projectId,
    sourceKind: input.sourceKind,
    triggerPhrases: input.triggerPhrases,
    dreamStatus: input.dreamStatus,
    dreamMeta: input.dreamMeta,
  });
  const indexing = await indexLongTermMemoryContent({
    memoryId: memory.id,
    content: memory.content,
    config: input.config,
  });

  invalidateRecallCache(input.userId);
  invalidateTriggerCache(input.userId);
  await invalidateProfileCache(input.userId);
  // reviewer A1:写入成功后必须 bump version(不可被调用方绕过)。
  if (input.userId) await bumpMemoryVersion(input.userId);
  deriveEdgesForMemory(memory.id, input.config)
    .catch(() => {})
    .finally(() => invalidateRecallCache(input.userId));

  return { memory, indexing, created };
}

export async function updateLongTermMemory(input: {
  id: string;
  content: string;
  config?: AppConfig;
}) {
  const memory = await updateLongTermMemoryRow(input.id, input.content);
  if (!memory) {
    return null;
  }

  const indexing = await indexLongTermMemoryContent({
    memoryId: memory.id,
    content: memory.content,
    config: input.config,
  });

  const ownerId = memory.userId ?? undefined;
  invalidateRecallCache(ownerId);
  invalidateTriggerCache(ownerId);
  await invalidateProfileCache(ownerId);
  // reviewer A1:写入成功后必须 bump version(不可被调用方绕过)。
  if (ownerId) await bumpMemoryVersion(ownerId);
  deriveEdgesForMemory(memory.id, input.config)
    .catch(() => {})
    .finally(() => invalidateRecallCache(ownerId));

  return { memory, indexing };
}

export async function deleteLongTermMemory(
  id: string,
  options?: { userId?: string },
) {
  const result = await deleteLongTermMemoryRow(id, options);
  if (result) {
    invalidateRecallCache(options?.userId);
    invalidateTriggerCache(options?.userId);
    await invalidateProfileCache(options?.userId);
    // reviewer A1:写入成功后必须 bump version(不可被调用方绕过)。
    if (options?.userId) await bumpMemoryVersion(options.userId);
  }
  return result;
}

export { deleteLongTermMemoryByKey } from '@/lib/core/db/memory/long-term';

export async function getLongTermMemory(id: string) {
  return getLongTermMemoryRow(id);
}

export async function listLongTermMemories(input?: {
  page?: number;
  pageSize?: number;
  search?: string;
  userId?: string;
  /**
   * Project scope filter (same semantics as listLongTermMemoryRows):
   * undefined/null = no filter, GLOBAL sentinel = global only, a real
   * project id = that project + global. Forwarded so callers that write
   * to a specific project scope (e.g. memory extraction) don't see a
   * cross-project `existing` list that mismatches the write target.
   *
   * NOTE: only applied on the list (non-search) path. The hybrid-search
   * path (searchLongTermMemories) does not yet accept a scope; callers
   * that need scoped results should avoid passing `search` together
   * with `projectIdScope`.
   */
  projectIdScope?: string | null;
}) {
  const page = Math.max(1, input?.page ?? 1);
  const pageSize = Math.max(1, Math.min(input?.pageSize ?? 50, 100));

  // If search query provided, use hybrid search. searchLongTermMemories does
  // not accept a project scope, so a caller asking for `search` together
  // with `projectIdScope` would silently get cross-project results — fail
  // loudly instead of letting the scope be ignored.
  if (input?.search) {
    if (input.projectIdScope !== undefined && input.projectIdScope !== null) {
      throw new Error(
        'listLongTermMemories: projectIdScope is not supported together with search',
      );
    }
    const results = await searchLongTermMemories({
      query: input.search,
      minConfidence: 0.05,
      page,
      pageSize,
      userId: input.userId,
    });
    // Convert HybridSearchRow[] to match the return shape of listLongTermMemoryRows
    return results.map((r: HybridSearchRow) => ({
      id: r.memoryId,
      userId: '',
      content: r.content,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }

  return listLongTermMemoryRows({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    userId: input?.userId,
    projectIdScope: input?.projectIdScope,
  });
}

export async function reindexLongTermMemory(input: {
  memoryId: string;
  config?: AppConfig;
}) {
  const memory = await getLongTermMemoryRow(input.memoryId);
  if (!memory) {
    throw new Error(`Memory ${input.memoryId} not found`);
  }

  const indexing = await indexLongTermMemoryContent({
    memoryId: memory.id,
    content: memory.content,
    config: input.config,
  });

  return { memory, indexing };
}

export async function reindexAllLongTermMemories(config?: AppConfig) {
  const rows = await listAllLongTermMemoryRows();

  return Promise.all(
    rows.map((memory) =>
      indexLongTermMemoryContent({
        memoryId: memory.id,
        content: memory.content,
        config,
      }).then((indexing) => ({
        memoryId: memory.id,
        indexing,
      })),
    ),
  );
}

export async function searchLongTermMemories(input: {
  query?: string;
  keywords?: string[];
  minConfidence: number;
  page?: number;
  pageSize?: number;
  userId?: string;
  config?: AppConfig;
}): Promise<HybridSearchRow[]> {
  const config = await getEffectiveConfig(input.config);
  const searchText = buildMemorySearchText({
    query: input.query,
    keywords: input.keywords,
  });
  const embeddingModel = config.models?.embedding_model;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 10, 100));
  const limit = pageSize;
  const offset = (page - 1) * pageSize;

  logger.info('search:start', {
    query: searchText,
    minConfidence: input.minConfidence,
    page,
    pageSize,
    embeddingModel: embeddingModel ?? null,
  });

  const fallbackSearch = async () => {
    const results = await hybridSearchLongTermMemoryChunks({
      searchText,
      minConfidence: input.minConfidence,
      limit,
      offset,
      userId: input.userId,
    });
    if (results.length > 0) {
      await updateLastAccessedAt(results.map((r) => r.chunkId));
    }
    return results;
  };

  if (!searchText || !embeddingModel) {
    return fallbackSearch();
  }

  try {
    const queryEmbedding = await generateEmbedding(
      searchText,
      embeddingModel,
      config,
    );

    const results = await hybridSearchLongTermMemoryChunks({
      searchText,
      minConfidence: input.minConfidence,
      limit,
      offset,
      queryEmbedding: queryEmbedding.embedding,
      queryEmbeddingModel: queryEmbedding.embeddingModel,
      queryEmbeddingDimensions: queryEmbedding.embeddingDimensions,
      userId: input.userId,
    });

    // Update lastAccessedAt for matched chunks (top-K results only)
    if (results.length > 0) {
      await updateLastAccessedAt(results.map((r) => r.chunkId));
    }

    return results;
  } catch (error) {
    logger.warn('search:embedding_failed', {
      embeddingModel,
      error: error instanceof Error ? error.message : String(error),
    });

    return fallbackSearch();
  }
}
