import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
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
      .replace(/[\[\]]/g, '')
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
