import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Canonical execution trace storage.
 *
 * The legacy message/tool/review tables remain domain stores during the
 * compatibility window, but Trace Explorer reads these tables first.  The
 * envelope is deliberately columnar for the fields used in access control
 * and ordering; producer-specific data lives in jsonb payload columns.
 */
export const traceRuns = pgTable(
  'trace_runs',
  {
    traceId: text('trace_id').primaryKey(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    userId: text('user_id'),
    sessionId: uuid('session_id'),
    taskId: uuid('task_id'),
    workspaceId: uuid('workspace_id'),
    nodeId: text('node_id'),
    agentId: text('agent_id'),
    input: jsonb('input').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull(),
    nextSequence: bigint('next_sequence', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex('trace_runs_idempotency_uniq').on(
      table.traceId,
      table.idempotencyKey,
    ),
    userStartedIdx: index('trace_runs_user_started_idx').on(
      table.userId,
      table.startedAt,
    ),
    sessionStartedIdx: index('trace_runs_session_started_idx').on(
      table.sessionId,
      table.startedAt,
    ),
    workspaceStartedIdx: index('trace_runs_workspace_started_idx').on(
      table.workspaceId,
      table.startedAt,
    ),
  }),
);

export const traceSpans = pgTable(
  'trace_spans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    userId: text('user_id'),
    sessionId: uuid('session_id'),
    taskId: uuid('task_id'),
    workspaceId: uuid('workspace_id'),
    nodeId: text('node_id'),
    agentId: text('agent_id'),
    input: jsonb('input').$type<unknown>(),
    output: jsonb('output').$type<unknown>(),
    error: jsonb('error').$type<unknown>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    spanIdIdx: uniqueIndex('trace_spans_trace_span_uniq').on(
      table.traceId,
      table.spanId,
    ),
    idempotencyIdx: uniqueIndex('trace_spans_idempotency_uniq').on(
      table.traceId,
      table.idempotencyKey,
    ),
    traceSequenceIdx: index('trace_spans_trace_sequence_idx').on(
      table.traceId,
      table.sequence,
      table.spanId,
    ),
    userStartedIdx: index('trace_spans_user_started_idx').on(
      table.userId,
      table.startedAt,
    ),
  }),
);

export const traceEvents = pgTable(
  'trace_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: text('event_id').notNull(),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id'),
    parentSpanId: text('parent_span_id'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    userId: text('user_id'),
    sessionId: uuid('session_id'),
    taskId: uuid('task_id'),
    workspaceId: uuid('workspace_id'),
    nodeId: text('node_id'),
    agentId: text('agent_id'),
    input: jsonb('input').$type<unknown>(),
    output: jsonb('output').$type<unknown>(),
    error: jsonb('error').$type<unknown>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    eventIdIdx: uniqueIndex('trace_events_trace_event_uniq').on(
      table.traceId,
      table.eventId,
    ),
    idempotencyIdx: uniqueIndex('trace_events_idempotency_uniq').on(
      table.traceId,
      table.idempotencyKey,
    ),
    traceSequenceIdx: index('trace_events_trace_sequence_idx').on(
      table.traceId,
      table.sequence,
      table.eventId,
    ),
    userStartedIdx: index('trace_events_user_started_idx').on(
      table.userId,
      table.startedAt,
    ),
  }),
);

export type TraceRun = typeof traceRuns.$inferSelect;
export type TraceSpan = typeof traceSpans.$inferSelect;
export type TraceEventRecord = typeof traceEvents.$inferSelect;
