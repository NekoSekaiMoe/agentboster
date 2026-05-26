import { embedMany } from 'ai';

import { generateEmbedding, resolveEmbeddingModel } from '@/lib/ai';
import {
  createLongTermMemoryRow,
  deleteLongTermMemoryRow,
  getLongTermMemoryRow,
  hybridSearchLongTermMemoryChunks,
  listAllLongTermMemoryRows,
  listLongTermMemoryRows,
  replaceLongTermMemoryChunks,
  updateLongTermMemoryRow,
} from '@/lib/core/db/memory/long-term';
import { getConfig } from '@/lib/core/kv/config';
import {
  type HybridSearchRow,
  buildMemorySearchText,
} from '@/lib/memory/search';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { LongTermMemoryIndexing } from '@/types/memory';

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
  config?: AppConfig;
}) {
  const memory = await createLongTermMemoryRow(input.content);
  const indexing = await indexLongTermMemoryContent({
    memoryId: memory.id,
    content: memory.content,
    config: input.config,
  });

  return { memory, indexing };
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

  return { memory, indexing };
}

export async function deleteLongTermMemory(id: string) {
  return deleteLongTermMemoryRow(id);
}

export async function getLongTermMemory(id: string) {
  return getLongTermMemoryRow(id);
}

export async function listLongTermMemories(input?: {
  page?: number;
  pageSize?: number;
  search?: string;
}) {
  const page = Math.max(1, input?.page ?? 1);
  const pageSize = Math.max(1, Math.min(input?.pageSize ?? 50, 100));

  // If search query provided, use hybrid search
  if (input?.search) {
    const results = await searchLongTermMemories({
      query: input.search,
      minConfidence: 0.2,
      page,
      pageSize,
    });
    // Convert HybridSearchRow[] to match the return shape of listLongTermMemoryRows
    return results.map((r: HybridSearchRow) => ({
      id: r.id,
      userId: '',
      content: r.content,
      createdAt: r.createdAt ?? new Date(),
      updatedAt: r.updatedAt ?? new Date(),
    }));
  }

  return listLongTermMemoryRows({
    limit: pageSize,
    offset: (page - 1) * pageSize,
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

  const fallbackSearch = () =>
    hybridSearchLongTermMemoryChunks({
      searchText,
      minConfidence: input.minConfidence,
      limit,
      offset,
    });

  if (!searchText || !embeddingModel) {
    return fallbackSearch();
  }

  try {
    const queryEmbedding = await generateEmbedding(
      searchText,
      embeddingModel,
      config,
    );

    return hybridSearchLongTermMemoryChunks({
      searchText,
      minConfidence: input.minConfidence,
      limit,
      offset,
      queryEmbedding: queryEmbedding.embedding,
      queryEmbeddingModel: queryEmbedding.embeddingModel,
      queryEmbeddingDimensions: queryEmbedding.embeddingDimensions,
    });
  } catch (error) {
    logger.warn('search:embedding_failed', {
      embeddingModel,
      error: error instanceof Error ? error.message : String(error),
    });

    return fallbackSearch();
  }
}
