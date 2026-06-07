import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: text('agent_id').default('global').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    emoji: text('emoji').default('book').notNull(),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    chunkSize: integer('chunk_size').default(1000).notNull(),
    chunkOverlap: integer('chunk_overlap').default(120).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    agentNameIdx: uniqueIndex('knowledge_bases_agent_name_idx').on(
      table.agentId,
      table.name,
    ),
    agentEnabledIdx: index('knowledge_bases_agent_enabled_idx').on(
      table.agentId,
      table.enabled,
    ),
  }),
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    knowledgeBaseId: uuid('knowledge_base_id')
      .references(() => knowledgeBases.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    sourceType: text('source_type', {
      enum: ['text', 'file', 'url', 'import'],
    })
      .default('text')
      .notNull(),
    sourceUri: text('source_uri'),
    contentHash: text('content_hash'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    kbCreatedIdx: index('knowledge_documents_kb_created_idx').on(
      table.knowledgeBaseId,
      table.createdAt,
    ),
    sourceIdx: index('knowledge_documents_source_idx').on(
      table.knowledgeBaseId,
      table.sourceType,
    ),
  }),
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    knowledgeBaseId: uuid('knowledge_base_id')
      .references(() => knowledgeBases.id, { onDelete: 'cascade' })
      .notNull(),
    documentId: uuid('document_id')
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' })
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
    kbChunkIdx: index('knowledge_chunks_kb_chunk_idx').on(
      table.knowledgeBaseId,
      table.chunkIndex,
    ),
    documentChunkIdx: index('knowledge_chunks_document_chunk_idx').on(
      table.documentId,
      table.chunkIndex,
    ),
    embeddingLookupIdx: index('knowledge_chunks_embedding_lookup_idx').on(
      table.embeddingModel,
      table.embeddingDimensions,
    ),
    tsvIdx: index('knowledge_chunks_tsv_idx').using('gin', table.tsv),
  }),
);
