import { db, schema } from '@/lib/core/db';
import type { MemoryEdgeRelation } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

const _logger = createLogger('db.memory.edges');

/**
 * Escape LIKE wildcards (`_` and `%`) in a literal string so it can be
 * safely used as a prefix pattern. Without this, a key prefix like
 * `user_profile` would match `userXprofile.*` because `_` is a single-
 * char wildcard in SQL LIKE.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

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
 * Returns connected memory IDs with their best edge weight and which seed
 * they came from, excluding seeds themselves.
 *
 * Tenant isolation: a `userId` MUST be supplied. Both endpoints of every
 * edge are constrained to belong to that user (via a join on
 * long_term_memories for src and dst), so no cross-tenant memory can ever
 * be reached through the graph — even if a stray edge linking two users'
 * memories somehow exists.
 *
 * Workspace isolation: when `workspaceId` is supplied, both endpoints must
 * ALSO be visible from that workspace — i.e. the row belongs to the
 * workspace OR is global (workspace_id IS NULL) — mirroring the seed
 * query's scope filter (buildWorkspaceVisibilityCondition in
 * lib/core/db/memory/long-term.ts). Without this, BFS neighbors could
 * leak another workspace's private memories. Omitting `workspaceId`
 * (undefined/null) preserves the legacy no-workspace-filter behavior.
 */
export async function getConnectedMemoryIds(
  seedMemoryIds: string[],
  userId: string,
  workspaceId?: string | null,
): Promise<
  { memoryId: string; relation: string; weight: number; seedId: string }[]
> {
  if (seedMemoryIds.length === 0 || !userId) return [];

  const srcMem = schema.longTermMemories;
  const dstMem = schema.longTermMemories;

  // Workspace scope fragment appended to each ownership EXISTS: the row
  // is in the current workspace OR global. Empty when unscoped.
  const scopeSql = workspaceId
    ? sql`AND (m.workspace_id = ${workspaceId} OR m.workspace_id IS NULL)`
    : sql``;

  // Join both endpoints to long_term_memories and require both to belong
  // to `userId`. We alias via two separate subqueries to keep it simple:
  // fetch edges where either endpoint is a seed, then verify ownership of
  // both endpoints in-query with EXISTS-style constraints expressed as
  // inArray against the user's memory ids is not viable (unbounded), so we
  // join twice using raw SQL aliases.
  const edges = await db
    .select({
      srcMemoryId: schema.memoryEdges.srcMemoryId,
      dstMemoryId: schema.memoryEdges.dstMemoryId,
      relation: schema.memoryEdges.relation,
      weight: schema.memoryEdges.weight,
    })
    .from(schema.memoryEdges)
    .where(
      and(
        or(
          inArray(schema.memoryEdges.srcMemoryId, seedMemoryIds),
          inArray(schema.memoryEdges.dstMemoryId, seedMemoryIds),
        ),
        // Both endpoints must belong to userId, and (when scoped) be
        // visible from the current workspace.
        sql`EXISTS (SELECT 1 FROM ${srcMem} m WHERE m.id = ${schema.memoryEdges.srcMemoryId} AND m.user_id = ${userId} ${scopeSql})`,
        sql`EXISTS (SELECT 1 FROM ${dstMem} m WHERE m.id = ${schema.memoryEdges.dstMemoryId} AND m.user_id = ${userId} ${scopeSql})`,
      ),
    );

  const seedSet = new Set(seedMemoryIds);
  const best = new Map<
    string,
    { relation: string; weight: number; seedId: string }
  >();

  for (const edge of edges) {
    const srcIsSeed = seedSet.has(edge.srcMemoryId);
    const connectedId = srcIsSeed ? edge.dstMemoryId : edge.srcMemoryId;
    const seedId = srcIsSeed ? edge.srcMemoryId : edge.dstMemoryId;

    if (seedSet.has(connectedId)) continue;

    const existing = best.get(connectedId);
    if (!existing || edge.weight > existing.weight) {
      best.set(connectedId, {
        relation: edge.relation,
        weight: edge.weight,
        seedId,
      });
    }
  }

  return Array.from(best.entries()).map(
    ([memoryId, { relation, weight, seedId }]) => ({
      memoryId,
      relation,
      weight,
      seedId,
    }),
  );
}

/**
 * Fetch content for a list of memory IDs (for BFS expansion results).
 * Scoped to `userId` so callers can never surface another tenant's
 * content even if an ID leaked into the id list. When `workspaceId` is
 * supplied, rows must additionally be in that workspace OR global
 * (workspace_id IS NULL) — the same scope semantics as the seed query.
 */
export async function getMemoryContentByIds(
  memoryIds: string[],
  userId: string,
  workspaceId?: string | null,
): Promise<Map<string, string>> {
  if (memoryIds.length === 0 || !userId) return new Map();

  const rows = await db
    .select({
      id: schema.longTermMemories.id,
      content: schema.longTermMemories.content,
    })
    .from(schema.longTermMemories)
    .where(
      and(
        inArray(schema.longTermMemories.id, memoryIds),
        eq(schema.longTermMemories.userId, userId),
        workspaceId
          ? or(
              eq(schema.longTermMemories.workspaceId, workspaceId),
              isNull(schema.longTermMemories.workspaceId),
            )
          : undefined,
      ),
    );

  return new Map(rows.map((row) => [row.id, row.content]));
}

/**
 * Find memories sharing the same key prefix as the given memory.
 * Key prefix is the part before the last dot (e.g., "user" from "user.location").
 * LIKE wildcards in the prefix are escaped so `user_x` cannot match `userYx`.
 */
export async function findMemoriesWithSameKeyPrefix(input: {
  memoryId: string;
  keyPrefix: string;
  userId: string;
  limit?: number;
}): Promise<string[]> {
  if (!input.userId) return [];

  const pattern = `${escapeLikeLiteral(input.keyPrefix)}.%`;

  const rows = await db
    .select({ id: schema.longTermMemories.id })
    .from(schema.longTermMemories)
    .where(
      and(
        eq(schema.longTermMemories.userId, input.userId),
        sql`${schema.longTermMemories.key} LIKE ${pattern} ESCAPE '\\'`,
        sql`${schema.longTermMemories.id} != ${input.memoryId}`,
      ),
    )
    .limit(input.limit ?? 20);

  return rows.map((r) => r.id);
}

/**
 * Find memories whose embeddings are highly similar to the given embedding.
 * Returns memory IDs (deduplicated from chunks, keeping the max similarity
 * per memory) with their cosine similarity. A `userId` MUST be supplied so
 * similarity search never crosses tenants.
 */
export async function findSimilarMemoryIds(input: {
  memoryId: string;
  embedding: number[];
  embeddingModel: string;
  embeddingDimensions: number;
  threshold: number;
  userId: string;
  limit?: number;
}): Promise<{ memoryId: string; similarity: number }[]> {
  if (!input.userId) return [];

  const distanceExpr = sql<number>`(${schema.longTermMemoryChunks.embedding} <=> ${`[${input.embedding.join(',')}]`}::vector)`;
  const similarityExpr = sql<number>`greatest(0, 1 - ${distanceExpr})`;
  const maxSimilarityExpr = sql<number>`max(${similarityExpr})`;

  // Aggregate by memoryId so multiple chunks of the same memory collapse
  // into one row (keeping the best similarity) BEFORE the limit is applied.
  const rows = await db
    .select({
      memoryId: schema.longTermMemoryChunks.memoryId,
      similarity: maxSimilarityExpr,
    })
    .from(schema.longTermMemoryChunks)
    .innerJoin(
      schema.longTermMemories,
      eq(schema.longTermMemoryChunks.memoryId, schema.longTermMemories.id),
    )
    .where(
      and(
        sql`${schema.longTermMemoryChunks.embedding} IS NOT NULL`,
        eq(schema.longTermMemoryChunks.embeddingModel, input.embeddingModel),
        eq(
          schema.longTermMemoryChunks.embeddingDimensions,
          input.embeddingDimensions,
        ),
        sql`${schema.longTermMemoryChunks.memoryId} != ${input.memoryId}`,
        eq(schema.longTermMemories.userId, input.userId),
      ),
    )
    .groupBy(schema.longTermMemoryChunks.memoryId)
    .having(sql`${maxSimilarityExpr} >= ${input.threshold}`)
    .orderBy(sql`${maxSimilarityExpr} DESC`)
    .limit(input.limit ?? 10);

  return rows.map((r) => ({ memoryId: r.memoryId, similarity: r.similarity }));
}
