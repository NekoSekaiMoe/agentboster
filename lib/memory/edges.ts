import {
  createMemoryEdge,
  deleteDerivedEdgesForMemory,
  findMemoriesWithSameKeyPrefix,
  findSimilarMemoryIds,
} from '@/lib/core/db/memory/edges';
import {
  getLongTermMemoryRow,
  listLongTermMemoryChunksForMemory,
} from '@/lib/core/db/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('memory.edges');

const SAME_TOPIC_EDGE_WEIGHT = 0.8;
const RELATED_SIMILARITY_THRESHOLD = 0.85;
const MAX_RELATED_EDGES = 5;
const MAX_SAME_TOPIC_EDGES = 10;

function extractKeyPrefix(key: string): string | null {
  const dotIndex = key.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  return key.slice(0, dotIndex);
}

/**
 * Derive graph edges for a memory after it is created or updated.
 *
 * Two edge types are derived:
 *  - same_topic: memories sharing the same key prefix (e.g., "user.location"
 *    and "user.name" share prefix "user").
 *  - related: memories whose embeddings have cosine similarity above threshold.
 *
 * Derived edges are fully recomputed each time — old derived edges for this
 * memory are deleted first, then new ones are inserted.
 */
export async function deriveEdgesForMemory(
  memoryId: string,
  _config?: AppConfig,
) {
  try {
    await deleteDerivedEdgesForMemory(memoryId);

    const memory = await getLongTermMemoryRow(memoryId);
    if (!memory) return;

    const edgePromises: Promise<unknown>[] = [];

    if (memory.key && memory.userId) {
      const prefix = extractKeyPrefix(memory.key);
      if (prefix) {
        edgePromises.push(
          deriveSameTopicEdges(memoryId, prefix, memory.userId),
        );
      }
    }

    edgePromises.push(deriveRelatedEdges(memoryId, memory.userId));

    await Promise.all(edgePromises);
  } catch (error) {
    logger.warn('derive_edges:failed', {
      memoryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function deriveSameTopicEdges(
  memoryId: string,
  keyPrefix: string,
  userId: string,
) {
  const siblingIds = await findMemoriesWithSameKeyPrefix({
    memoryId,
    keyPrefix,
    userId,
    limit: MAX_SAME_TOPIC_EDGES,
  });

  if (siblingIds.length === 0) return;

  logger.info('derive_edges:same_topic', {
    memoryId,
    keyPrefix,
    siblingCount: siblingIds.length,
  });

  await Promise.all(
    siblingIds.map((siblingId) => {
      const [src, dst] =
        memoryId < siblingId
          ? [memoryId, siblingId]
          : [siblingId, memoryId];
      return createMemoryEdge({
        srcMemoryId: src,
        dstMemoryId: dst,
        relation: 'same_topic',
        weight: SAME_TOPIC_EDGE_WEIGHT,
      });
    }),
  );
}

async function deriveRelatedEdges(memoryId: string, userId?: string | null) {
  const chunks = await listLongTermMemoryChunksForMemory(memoryId);
  const chunk = chunks[0];
  if (!chunk?.embedding || !chunk.embeddingModel || !chunk.embeddingDimensions) {
    return;
  }

  const similar = await findSimilarMemoryIds({
    memoryId,
    embedding: chunk.embedding,
    embeddingModel: chunk.embeddingModel,
    embeddingDimensions: chunk.embeddingDimensions,
    threshold: RELATED_SIMILARITY_THRESHOLD,
    userId: userId ?? undefined,
    limit: MAX_RELATED_EDGES,
  });

  if (similar.length === 0) return;

  logger.info('derive_edges:related', {
    memoryId,
    relatedCount: similar.length,
    topSimilarity: similar[0]?.similarity,
  });

  await Promise.all(
    similar.map(({ memoryId: relatedId, similarity }) => {
      const [src, dst] =
        memoryId < relatedId
          ? [memoryId, relatedId]
          : [relatedId, memoryId];
      const weight = Math.min(1.0, (similarity - RELATED_SIMILARITY_THRESHOLD) / (1 - RELATED_SIMILARITY_THRESHOLD));
      return createMemoryEdge({
        srcMemoryId: src,
        dstMemoryId: dst,
        relation: 'related',
        weight: Math.max(0.3, weight),
      });
    }),
  );
}
