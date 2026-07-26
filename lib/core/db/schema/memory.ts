import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { sessions } from './chat';

// ─── Custom types for PostgreSQL search/vector columns ──────────────

const variableVector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value) {
    return String(value)
      .replace(/[[\]]/g, '')
      .split(',')
      .filter((part) => part.length > 0)
      .map(Number);
  },
});

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ─── Builtin Memories ───────────────────────────────────────────────

export const builtinMemories = pgTable('builtin_memories', {
  key: text('key', {
    enum: ['AGENTS', 'SOUL', 'IDENTITY', 'USER'],
  }).primaryKey(),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── Session Memories ───────────────────────────────────────────────

export const sessionMemories = pgTable(
  'session_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    content: text('content').notNull(),
    summaryVersion: integer('summary_version').notNull(),
    isCurrent: boolean('is_current').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionCurrentIdx: index('session_memories_session_current_idx').on(
      table.sessionId,
      table.isCurrent,
    ),
  }),
);

// ─── Long-term Memories ─────────────────────────────────────────────

export const longTermMemories = pgTable(
  'long_term_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').default('system'),
    // Optional project scope. When set, the memory is partitioned to a
    // specific project/workspace so recall can be filtered per-project
    // and the project-aggregate view can group memories by project. Null
    // means "global / cross-project" (the historical default). Modeled as
    // a free-text identifier (workspaces.project_id) rather than an FK so
    // memories survive workspace archival without cascading deletes.
    projectId: text('project_id'),
    // Optional stable key for dedup during memory extraction. When set,
    // (userId, projectId, key) is unique so the extractor can upsert by
    // key within a scope. Manual memory writes (UI, writeMemory tool)
    // leave this null — there is no unique constraint on null so multiple
    // null keys coexist fine in Postgres.
    key: text('memory_key'),
    content: text('content').notNull(),
    memoryType: text('memory_type', {
      enum: ['fact', 'preference', 'decision', 'conversation'],
    })
      .default('fact')
      .notNull(),
    importance: integer('importance').default(5).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userUpdatedIdx: index('long_term_memories_user_updated_idx').on(
      table.userId,
      table.updatedAt,
    ),
    memoryTypeIdx: index('long_term_memories_memory_type_idx').on(
      table.memoryType,
    ),
    // The historical unique index was (userId, key). Adding projectId to
    // the uniqueness set lets the same logical key (e.g. "tech_stack")
    // exist once per project without colliding, while global memories
    // (projectId IS NULL) still dedupe per user. Null projectId still
    // participates in uniqueness (NULL != NULL in SQL would break this,
    // so callers MUST always pass projectId consistently for keyed writes
    // — either a real id or the GLOBAL_PROJECT_ID sentinel).
    userProjectKeyIdx: uniqueIndex(
      'long_term_memories_user_project_key_idx',
    ).on(table.userId, table.projectId, table.key),
    // Replace the old (userId, key) index with a non-unique covering index
    // so project-scoped recall queries (`WHERE userId=? AND projectId=?`)
    // stay fast without being constrained by the uniqueness rule above.
    userProjectUpdatedIdx: index(
      'long_term_memories_user_project_updated_idx',
    ).on(table.userId, table.projectId, table.updatedAt),
  }),
);

// ─── Long-term Memory Chunks ────────────────────────────────────────

export const longTermMemoryChunks = pgTable(
  'long_term_memory_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    memoryId: uuid('memory_id')
      .references(() => longTermMemories.id, { onDelete: 'cascade' })
      .notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: variableVector('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    tsv: tsvector('tsv'),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    embeddingLookupIdx: index('ltm_chunks_embedding_lookup_idx').on(
      table.embeddingModel,
      table.embeddingDimensions,
    ),
    memoryChunkIdx: index('ltm_chunks_memory_chunk_idx').on(
      table.memoryId,
      table.chunkIndex,
    ),
    tsvIdx: index('ltm_chunks_tsv_idx').using('gin', table.tsv),
  }),
);

// ─── Memory Edges (graph relationships between long-term memories) ──

export type MemoryEdgeRelation =
  | 'same_topic'
  | 'related'
  | 'supersedes'
  | 'contradicts';

export const memoryEdges = pgTable(
  'memory_edges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    srcMemoryId: uuid('src_memory_id')
      .references(() => longTermMemories.id, { onDelete: 'cascade' })
      .notNull(),
    dstMemoryId: uuid('dst_memory_id')
      .references(() => longTermMemories.id, { onDelete: 'cascade' })
      .notNull(),
    relation: text('relation').$type<MemoryEdgeRelation>().notNull(),
    weight: real('weight').default(1.0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    srcIdx: index('memory_edges_src_idx').on(table.srcMemoryId),
    dstIdx: index('memory_edges_dst_idx').on(table.dstMemoryId),
    uniqueEdgeIdx: uniqueIndex('memory_edges_unique_idx').on(
      table.srcMemoryId,
      table.dstMemoryId,
      table.relation,
    ),
    // The $type<>() above only constrains TypeScript; the column is plain
    // text at the DB level. Enforce the allowed relation set with a CHECK so
    // an invalid relation can never enter the graph (and mislead BFS recall).
    relationCheck: check(
      'memory_edges_relation_check',
      sql`${table.relation} IN ('same_topic', 'related', 'supersedes', 'contradicts')`,
    ),
  }),
);
