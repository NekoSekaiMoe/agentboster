import { embedMany } from 'ai';

import {
  createKnowledgeBaseRow,
  createKnowledgeDocumentRow,
  canManageKnowledgeBaseRow,
  getKnowledgeBaseRow,
  hashKnowledgeContent,
  hybridSearchKnowledgeChunks,
  listKnowledgeBaseRows,
  listKnowledgeDocumentRows,
  replaceKnowledgeDocumentChunks,
  resolveKnowledgeBaseRows,
  type KnowledgeBaseRow,
  type KnowledgeAccessScope,
  type KnowledgeVisibility,
  type KnowledgeChunkInput,
  type KnowledgeSearchRow,
} from '@/lib/core/db/knowledge';
import { getConfig } from '@/lib/core/kv/config';
import { generateEmbedding, resolveEmbeddingModel } from '@/lib/ai';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('knowledge');

type KnowledgeIndexing = {
  mode: 'embedded' | 'keyword_only_no_model' | 'keyword_only_embedding_failed';
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  warning: string | null;
};

function normalizeSourceType(
  value: unknown,
): 'text' | 'file' | 'url' | 'import' {
  return value === 'file' || value === 'url' || value === 'import'
    ? value
    : 'text';
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  input: {
    min: number;
    max: number;
  },
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(
    input.min,
    Math.min(Math.trunc(value ?? fallback), input.max),
  );
}

function splitTextIntoChunks(input: {
  content: string;
  chunkSize: number;
  chunkOverlap: number;
}) {
  const content = input.content.trim();
  if (!content) {
    return [];
  }

  const chunkSize = clampInteger(input.chunkSize, 1000, {
    min: 200,
    max: 8000,
  });
  const chunkOverlap = clampInteger(input.chunkOverlap, 120, {
    min: 0,
    max: Math.floor(chunkSize / 2),
  });
  const chunks: Array<{ chunkIndex: number; content: string }> = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length);

    if (end < content.length) {
      const window = content.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
      );

      if (boundary > Math.floor(chunkSize * 0.55)) {
        end = start + boundary;
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk) {
      chunks.push({ chunkIndex: chunks.length, content: chunk });
    }

    const nextStart = Math.max(end - chunkOverlap, start + 1);
    start = nextStart;
  }

  return chunks;
}

async function getEffectiveConfig(config?: AppConfig) {
  return config ?? (await getConfig());
}

async function buildIndexedChunks(input: {
  chunks: Array<{ chunkIndex: number; content: string }>;
  embeddingModel: string | null;
  config: AppConfig;
}): Promise<{
  chunks: KnowledgeChunkInput[];
  indexing: KnowledgeIndexing;
}> {
  if (!input.embeddingModel || input.chunks.length === 0) {
    return {
      chunks: input.chunks.map((chunk) => ({
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
    const model = resolveEmbeddingModel(input.embeddingModel, input.config);
    const { embeddings } = await embedMany({
      model,
      values: input.chunks.map((chunk) => chunk.content),
    });
    const embeddingDimensions = embeddings[0]?.length ?? null;

    return {
      chunks: input.chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index] ?? null,
        embeddingModel: input.embeddingModel,
        embeddingDimensions: embeddings[index]?.length ?? null,
      })),
      indexing: {
        mode: 'embedded',
        embeddingModel: input.embeddingModel,
        embeddingDimensions,
        warning: null,
      },
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);

    logger.warn('index:embedding_failed', {
      embeddingModel: input.embeddingModel,
      warning,
    });

    return {
      chunks: input.chunks.map((chunk) => ({
        ...chunk,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      })),
      indexing: {
        mode: 'keyword_only_embedding_failed',
        embeddingModel: input.embeddingModel,
        embeddingDimensions: null,
        warning,
      },
    };
  }
}

export async function listKnowledgeBases(input?: {
  agentId?: string;
  includeDisabled?: boolean;
  access?: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const rows = await listKnowledgeBaseRows(input);
  const access = input?.access;
  if (!access) {
    return rows;
  }

  return rows.map((row) => ({
    ...row,
    canManage: canManageKnowledgeBaseRow(row, access),
  }));
}

export async function createKnowledgeBase(input: {
  agentId?: string;
  ownerUserId?: string | null;
  visibility?: KnowledgeVisibility;
  name: string;
  description?: string | null;
  emoji?: string | null;
  embeddingModel?: string | null;
  chunkSize?: number;
  chunkOverlap?: number;
  config?: AppConfig;
}) {
  const config = await getEffectiveConfig(input.config);
  const embeddingModel =
    input.embeddingModel ?? config.models?.embedding_model ?? null;

  return createKnowledgeBaseRow({
    agentId: input.agentId,
    ownerUserId: input.ownerUserId,
    visibility: input.visibility,
    name: input.name.trim(),
    description: input.description,
    emoji: input.emoji,
    embeddingModel,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
  });
}

export async function listKnowledgeDocuments(
  knowledgeBaseId: string,
  options?: {
    access?: KnowledgeAccessScope;
    includeAllPrivate?: boolean;
  },
) {
  const knowledgeBase = await getKnowledgeBaseRow(knowledgeBaseId, {
    access: options?.access,
    includeAllPrivate: options?.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${knowledgeBaseId} not found`);
  }

  return listKnowledgeDocumentRows(knowledgeBaseId);
}

export async function addKnowledgeDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content: string;
  sourceType?: 'text' | 'file' | 'url' | 'import';
  sourceUri?: string | null;
  metadata?: Record<string, unknown> | null;
  config?: AppConfig;
  access?: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getKnowledgeBaseRow(input.knowledgeBaseId, {
    access: input.access,
    includeAllPrivate: input.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  if (input.access && !canManageKnowledgeBaseRow(knowledgeBase, input.access)) {
    throw new Error('Forbidden');
  }

  const config = await getEffectiveConfig(input.config);
  const chunks = splitTextIntoChunks({
    content: input.content,
    chunkSize: knowledgeBase.chunkSize,
    chunkOverlap: knowledgeBase.chunkOverlap,
  });

  if (chunks.length === 0) {
    throw new Error('Document content is empty');
  }

  const embeddingModel =
    knowledgeBase.embeddingModel ?? config.models?.embedding_model ?? null;
  const { chunks: indexedChunks, indexing } = await buildIndexedChunks({
    chunks,
    embeddingModel,
    config,
  });
  const document = await createKnowledgeDocumentRow({
    knowledgeBaseId: knowledgeBase.id,
    title: input.title.trim(),
    sourceType: normalizeSourceType(input.sourceType),
    sourceUri: input.sourceUri,
    contentHash: hashKnowledgeContent(input.content),
    metadata: {
      ...(input.metadata ?? {}),
      rawLength: input.content.length,
    },
  });

  await replaceKnowledgeDocumentChunks({
    knowledgeBaseId: knowledgeBase.id,
    documentId: document.id,
    chunks: indexedChunks,
  });

  return {
    document,
    chunkCount: indexedChunks.length,
    indexing,
  };
}

function selectSearchEmbeddingModel(input: {
  knowledgeBases: KnowledgeBaseRow[];
  config: AppConfig;
}) {
  return (
    input.knowledgeBases.find((knowledgeBase) => knowledgeBase.embeddingModel)
      ?.embeddingModel ??
    input.config.models?.embedding_model ??
    null
  );
}

export async function searchKnowledge(input: {
  query: string;
  agentId?: string;
  knowledgeBaseIds?: string[];
  knowledgeBaseNames?: string[];
  limit?: number;
  minConfidence?: number;
  config?: AppConfig;
  access?: KnowledgeAccessScope;
}): Promise<KnowledgeSearchRow[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const config = await getEffectiveConfig(input.config);
  const knowledgeBases = await resolveKnowledgeBaseRows({
    agentId: input.agentId,
    knowledgeBaseIds: input.knowledgeBaseIds,
    knowledgeBaseNames: input.knowledgeBaseNames,
    access: input.access,
  });
  const hasExplicitKnowledgeBaseFilter =
    (input.knowledgeBaseIds?.length ?? 0) > 0 ||
    (input.knowledgeBaseNames?.length ?? 0) > 0;

  if (hasExplicitKnowledgeBaseFilter && knowledgeBases.length === 0) {
    return [];
  }
  if (knowledgeBases.length === 0) {
    return [];
  }

  const knowledgeBaseIds = knowledgeBases.map(
    (knowledgeBase) => knowledgeBase.id,
  );
  const embeddingModel = selectSearchEmbeddingModel({
    knowledgeBases,
    config,
  });
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const minConfidence = Math.max(0, input.minConfidence ?? 0);

  if (!embeddingModel) {
    return hybridSearchKnowledgeChunks({
      searchText: query,
      minConfidence,
      limit,
      offset: 0,
      agentId: input.agentId,
      knowledgeBaseIds,
    });
  }

  try {
    const queryEmbedding = await generateEmbedding(
      query,
      embeddingModel,
      config,
    );

    return hybridSearchKnowledgeChunks({
      searchText: query,
      queryEmbedding: queryEmbedding.embedding,
      queryEmbeddingModel: queryEmbedding.embeddingModel,
      queryEmbeddingDimensions: queryEmbedding.embeddingDimensions,
      minConfidence,
      limit,
      offset: 0,
      agentId: input.agentId,
      knowledgeBaseIds,
    });
  } catch (error) {
    logger.warn('search:embedding_failed', {
      embeddingModel,
      error: error instanceof Error ? error.message : String(error),
    });

    return hybridSearchKnowledgeChunks({
      searchText: query,
      minConfidence,
      limit,
      offset: 0,
      agentId: input.agentId,
      knowledgeBaseIds,
    });
  }
}
