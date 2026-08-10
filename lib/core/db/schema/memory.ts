import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

export const builtinMemories = pgTable(
  'builtin_memories',
  {
    key: text('key', {
      enum: ['AGENTS', 'SOUL', 'IDENTITY', 'USER'],
    }).notNull(),
    /** Workspace scope. NULL = global template row cloned into new
     *  workspaces on creation. Each workspace can evolve its own
     *  SOUL/IDENTITY/etc. independently.
     *
     *  NOTE: do NOT put the nullable `workspaceId` in a composite PRIMARY
     *  KEY — PostgreSQL forces all PK columns NOT NULL, which would make
     *  the global template row (workspace_id IS NULL) impossible to
     *  persist. Instead a synthetic PK + two unique constraints encode
     *  the intended semantics: global rows are unique per key, and
     *  workspace-scoped rows are unique per (workspace_id, key).
     *  `NULLS NOT DISTINCT` lets the partial global uniqueness treat
     *  NULL workspace_id deterministically so two global rows with the
     *  same key cannot coexist. */
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id'),
    content: text('content').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Global templates: exactly one row per key when workspace_id IS NULL.
    globalKeyUnique: uniqueIndex('builtin_memories_global_key_idx')
      .on(table.key)
      .where(sql`workspace_id IS NULL`),
    // Workspace-scoped: one row per (workspace_id, key).
    workspaceKeyUnique: uniqueIndex('builtin_memories_workspace_key_idx').on(
      table.workspaceId,
      table.key,
    ),
  }),
);

// ─── Session Memories ───────────────────────────────────────────────

export const sessionMemories = pgTable(
  'session_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    /** Redundant workspace scope for efficient per-workspace aggregation.
     *  Stays per-session (one summary per session); not shared across
     *  sessions like long_term_memories. */
    workspaceId: uuid('workspace_id'),
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
    projectId: text('project_id').default('__global__').notNull(),
    /** Workspace scope (new). Nullable = global/cross-workspace (the
     *  historical default). M2 backfill maps legacy `__global__` and
     *  `proj-xxx` rows to NULL here. Recall filters on (workspace_id=? OR
     *  workspace_id IS NULL) so global memories stay visible everywhere. */
    workspaceId: uuid('workspace_id'),
    /** Owner (creator) of this memory. Kept even for shared memories so
     *  the workspace can render provenance; recall visibility is governed
     *  by `shared` below. */
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
    /**
     * Whether this memory is shared across all members of the workspace.
     * When true (default), recall sees it regardless of `userId`. When
     * false, only the creator (`userId`) sees it. Single-user MVP: always
     * true in practice; the flag exists so future multi-member
     * workspaces get per-memory privacy without a schema change.
     */
    shared: boolean('shared').default(true).notNull(),
    /**
     * Dream lifecycle state. `active` is the default for back-compat
     * (legacy rows + normal extractor writes are always active and
     * participate in recall). Dream Phase 2 writes `tentative`; the
     * ratification pass flips tentative → active. Phase 1 consolidation
     * flips superseded sources here instead of deleting them, so the
     * audit trail survives.
     *
     * Kept as a top-level column (not jsonb) so recall can filter
     * `WHERE dream_status = 'active'` on a partial index without a
     * jsonb scan. Mirrors AutoGPT's Graphiti edge `status` property.
     */
    dreamStatus: text('dream_status', {
      enum: ['active', 'tentative', 'superseded', 'contradicted'],
    })
      .default('active')
      .notNull(),
    /**
     * Optional Dream metadata: confidence, source_kind, provenance,
     * ratification state. Stored as jsonb because these are write-once-
     * then-read fields that recall does NOT filter on — only the UI/audit
     * reads them. Typed loosely (with hinted fields) so different writers
     * (consolidator, recombine, ratify) can record their own fields
     * without forcing a schema migration for each new key. Matches the
     * DreamMeta interface in lib/memory/dream/types.ts.
     */
    dreamMeta: jsonb('dream_meta').$type<
      {
        confidence?: number;
        sourceKind?:
          | 'user_asserted'
          | 'assistant_observed'
          | 'tool_observed'
          | 'dream_consolidated'
          | 'dream_recombined';
        provenance?: {
          sourceMemoryIds?: string[];
          supersededBy?: string;
          dreamRunId?: string;
        };
        rationale?: string;
        lastDreamAt?: string;
        // Ratification pass fields (written by ratifyLongTermMemory).
        ratified?: boolean;
        ratifiedAt?: string;
        reviewNote?: string;
      } & Record<string, unknown>
    >(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Provenance / trust classification (OpenClaw-style taint gate).
     * Closed set, written by classification code — never parsed out of
     * memory text. Drives structural rules elsewhere:
     *  - `tool_observed` rows are excluded from the always-on developer
     *    profile and wrapped as unverified context on recall injection.
     *  - Dream usage-based importance boosts skip `tool_observed` rows.
     * Legacy rows (pre-column) default to 'assistant_observed', the
     * neutral mid-trust class that keeps historical behavior unchanged.
     */
    sourceKind: text('source_kind', {
      enum: [
        'user_asserted',
        'assistant_observed',
        'tool_observed',
        'dream_consolidated',
        'dream_recombined',
      ],
    })
      .default('assistant_observed')
      .notNull(),
    /**
     * Short trigger phrases describing WHEN this memory is relevant
     * (OpenClaw `<!-- trigger: ... -->` annotations). Each inbound message
     * runs a cheap lexical prefilter against these phrases; strong matches
     * inject the memory without waiting for semantic recall. Written at
     * extraction / write time by writers that already have an LLM in the
     * loop. NULL = no trigger candidates (older rows stay neutral).
     */
    triggerPhrases: text('trigger_phrases').array(),
    /**
     * Usage-feedback signals (OpenClaw dreaming deep-ranking analogue:
     * "memory graduates because it kept being useful"). Incremented by the
     * recall path each time this row is surfaced into a prompt; consumed
     * by Dream phase 1 to boost frequently-recalled facts and demote
     * never-recalled stale ones.
     */
    recallCount: integer('recall_count').default(0).notNull(),
    /**
     * Capped list of `yyyymmdd:queryHash` buckets, one per distinct
     * day+query context that surfaced this memory. Length approximates
     * OpenClaw's "unique queries" ranking signal without storing raw
     * query text. Capped (see MAX_RECALL_QUERY_HASHES in the DAL).
     */
    recallQueryHashes: jsonb('recall_query_hashes').$type<string[]>(),
    /** Last time recall surfaced this memory into a prompt. */
    lastRecalledAt: timestamp('last_recalled_at', { withTimezone: true }),
  },
  (table) => ({
    userUpdatedIdx: index('long_term_memories_user_updated_idx').on(
      table.userId,
      table.updatedAt,
    ),
    memoryTypeIdx: index('long_term_memories_memory_type_idx').on(
      table.memoryType,
    ),
    // The historical unique index was (userId, key). Uniqueness is now
    // enforced by TWO partial unique indexes so NULL workspace_id stays
    // deterministic without NULLS NOT DISTINCT on the whole composite
    // (which would also collapse rows whose memory key is NULL — keyed
    // writes rely on NULL keys staying distinct):
    //  - global rows (workspace_id IS NULL): unique on
    //    (userId, projectId, key) — two global rows with the same
    //    (user, project, key) cannot coexist.
    //  - workspace rows (workspace_id IS NOT NULL): unique on
    //    (userId, projectId, key, workspaceId) so the same logical key
    //    (e.g. "tech_stack") can exist once per (project, workspace) pair.
    userProjectKeyGlobalIdx: uniqueIndex(
      'long_term_memories_user_project_key_global_uniq',
    )
      .on(table.userId, table.projectId, table.key)
      .where(sql`workspace_id IS NULL`),
    userProjectKeyIdx: uniqueIndex('long_term_memories_user_project_key_idx')
      .on(table.userId, table.projectId, table.key, table.workspaceId)
      .where(sql`workspace_id IS NOT NULL`),
    // Replace the old (userId, key) index with a non-unique covering index
    // so project-scoped recall queries (`WHERE userId=? AND projectId=?`)
    // stay fast without being constrained by the uniqueness rule above.
    userProjectUpdatedIdx: index(
      'long_term_memories_user_project_updated_idx',
    ).on(table.userId, table.projectId, table.updatedAt),
    // Partial index: only index rows where Dream lifecycle matters for
    // filtering. Recall excludes superseded/contradicted/tentative via
    // `WHERE dream_status = 'active'` — without this index that filter
    // would seq-scan on large tables. Active rows are the overwhelming
    // majority so indexing only the non-active tail would be backwards;
    // instead we index active explicitly so the common path is an index
    // scan, and the rare non-active lookups (admin UI) tolerate a seq
    // scan over a small set.
    dreamStatusActiveIdx: index('long_term_memories_dream_status_active_idx')
      .on(table.userId, table.dreamStatus)
      .where(sql`dream_status = 'active'`),
    // Workspace-scoped recall: `WHERE workspace_id = ?` (the common
    // M2 path). Nullable column, so global rows (NULL) won't live in this
    // index — they're fetched via the additive `OR workspace_id IS NULL`
    // arm of the recall filter.
    workspaceIdx: index('long_term_memories_workspace_idx').on(
      table.workspaceId,
    ),
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
