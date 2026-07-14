import { db, schema } from '@/lib/core/db';
import type { MemoryEdgeRelation } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

const _logger = createLogger('db.memory.edges');

export async function createMemoryEdge(input: {
  srcMemoryId: string;
  dstMemoryId: string;
  relation: MemoryEdgeRelation;
  weight?: number;
}) {
  const [row] = await db
    .insert(schema.memoryEdges)
    .values({
      srcMemoryId: input.srcMemoryId,
      dstMemoryId: input.dstMemoryId,
      relation: input.relation,
      weight: input.weight ?? 1.0,
    })
    .onConflictDoUpdate({
      target: [
        schema.memoryEdges.srcMemoryId,
        schema.memoryEdges.dstMemoryId,
        schema.memoryEdges.relation,
      ],
      set: { weight: input.weight ?? 1.0 },
    })
    .returning();

  return row;
}

export async function deleteEdgesForMemory(memoryId: string) {
  await db
    .delete(schema.memoryEdges)
    .where(
      or(
        eq(schema.memoryEdges.srcMemoryId, memoryId),
        eq(schema.memoryEdges.dstMemoryId, memoryId),
      ),
    );
}

export async function deleteDerivedEdgesForMemory(memoryId: string) {
  await db
    .delete(schema.memoryEdges)
    .where(
      and(
        or(
          eq(schema.memoryEdges.srcMemoryId, memoryId),
          eq(schema.memoryEdges.dstMemoryId, memoryId),
        ),
        inArray(schema.memoryEdges.relation, ['same_topic', 'related']),
      ),
    );
}

/**
 * Find memories connected to a set of seed memory IDs via edges (1 hop).
 * Returns connected memory IDs with their best edge weight, excluding seeds.
 */
export async function getConnectedMemoryIds(
  seedMemoryIds: string[],
): Promise<{ memoryId: string; relation: string; weight: number }[]> {
  if (seedMemoryIds.length === 0) return [];

  const edges = await db
    .select({
      srcMemoryId: schema.memoryEdges.srcMemoryId,
      dstMemoryId: schema.memoryEdges.dstMemoryId,
      relation: schema.memoryEdges.relation,
      weight: schema.memoryEdges.weight,
    })
    .from(schema.memoryEdges)
    .where(
      or(
        inArray(schema.memoryEdges.srcMemoryId, seedMemoryIds),
        inArray(schema.memoryEdges.dstMemoryId, seedMemoryIds),
      ),
    );

  const seedSet = new Set(seedMemoryIds);
  const best = new Map<string, { relation: string; weight: number }>();

  for (const edge of edges) {
    const connectedId = seedSet.has(edge.srcMemoryId)
      ? edge.dstMemoryId
      : edge.srcMemoryId;

    if (seedSet.has(connectedId)) continue;

    const existing = best.get(connectedId);
    if (!existing || edge.weight > existing.weight) {
      best.set(connectedId, { relation: edge.relation, weight: edge.weight });
    }
  }

  return Array.from(best.entries()).map(([memoryId, { relation, weight }]) => ({
    memoryId,
    relation,
    weight,
  }));
}

/**
 * Fetch content for a list of memory IDs (for BFS expansion results).
 */
export async function getMemoryContentByIds(
  memoryIds: string[],
): Promise<Map<string, string>> {
  if (memoryIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: schema.longTermMemories.id,
      content: schema.longTermMemories.content,
    })
    .from(schema.longTermMemories)
    .where(inArray(schema.longTermMemories.id, memoryIds));

  return new Map(rows.map((row) => [row.id, row.content]));
}

/**
 * Find memories sharing the same key prefix as the given memory.
 * Key prefix is the part before the last dot (e.g., "user" from "user.location").
 */
export async function findMemoriesWithSameKeyPrefix(input: {
  memoryId: string;
  keyPrefix: string;
  userId: string;
  limit?: number;
}): Promise<string[]> {
  const rows = await db
    .select({ id: schema.longTermMemories.id })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        sql`${schema.longTermMemories.key} LIKE ${`${input.keyPrefix}.%`}`,
        sql`${schema.longTermMemories.id} != ${input.memoryId}`,
      ),
    )
    .limit(input.limit ?? 20);

  return rows.map((r) => r.id);
}

/**
 * Find memories whose embeddings are highly similar to the given embedding.
 * Returns memory IDs (deduplicated from chunks) with their cosine similarity.
 */
export async function findSimilarMemoryIds(input: {
  memoryId: string;
  embedding: number[];
  embeddingModel: string;
  embeddingDimensions: number;
  threshold: number;
  userId?: string;
  limit?: number;
}): Promise<{ memoryId: string; similarity: number }[]> {
  const distanceExpr = sql<number>`(${schema.longTermMemoryChunks.embedding} <=> ${`[${input.embedding.join(',')}]`}::vector)`;
  const similarityExpr = sql<number>`greatest(0, 1 - ${distanceExpr})`;

  const conditions = [
    sql`${schema.longTermMemoryChunks.embedding} IS NOT NULL`,
    eq(schema.longTermMemoryChunks.embeddingModel, input.embeddingModel),
    eq(
      schema.longTermMemoryChunks.embeddingDimensions,
      input.embeddingDimensions,
    ),
    sql`${schema.longTermMemoryChunks.memoryId} != ${input.memoryId}`,
  ];

  if (input.userId) {
    conditions.push(eq(schema.longTermMemories.userId, input.userId));
  }

  const rows = await db
    .select({
      memoryId: schema.longTermMemoryChunks.memoryId,
      similarity: similarityExpr,
    })
    .from(schema.longTermMemoryChunks)
    .innerJoin(
      schema.longTermMemories,
      eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
    )
    .where(and(...conditions))
    .orderBy(sql`${similarityExpr} DESC`)
    .limit(input.limit ?? 10);

  return rows
    .filter((r) => r.similarity >= input.threshold)
    .map((r) => ({ memoryId: r.memoryId, similarity: r.similarity }));
}
