import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title'),
  channel: text('channel').default('web').notNull(),
  channelOrigin: text('channel_origin'),
  externalThreadId: text('external_thread_id'),
  userId: text('user_id'),
  model: text('model'),
  systemPrompt: text('system_prompt'),
  soulContent: text('soul_content'),
  status: text('status', {
    enum: ['active', 'completed', 'stopped', 'error'],
  })
    .default('active')
    .notNull(),
  workflowRunId: text('workflow_run_id'),
  sandboxId: text('sandbox_id'),
  remoteControlNodeId: text('remote_control_node_id'),
  totalTokens: integer('total_tokens').default(0).notNull(),
  latestTokenUsage:
    jsonb('latest_token_usage').$type<Record<string, unknown>>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  archived: boolean('archived').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    uiMessageId: text('ui_message_id'),
    visibleInChat: boolean('visible_in_chat').default(true).notNull(),
    role: text('role', {
      enum: ['user', 'assistant', 'summary', 'tool', 'system'],
    }).notNull(),
    stepNumber: integer('step_number'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionUiMessageIdIdx: uniqueIndex('messages_session_ui_message_id_idx').on(
      table.sessionId,
      table.uiMessageId,
    ),
  }),
);

export type ChatSession = typeof sessions.$inferSelect;
