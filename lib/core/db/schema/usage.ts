import {
  bigint,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Per-task, per-(provider, model) token usage aggregate.
 *
 * Ported from Multica migration 032 + the cost_usd_ticks addition (213).
 * One row per distinct (taskId, provider, model) combination — a multi-step
 * task that calls two models produces two rows. The UNIQUE constraint makes
 * upserting idempotent: a re-reported usage for the same key adds rather
 * than duplicates (callers read-then-write via the DAL helper).
 *
 * `costUsdTicks` is the provider-reported authoritative cost in 1e-10 USD
 * ticks (an integer to avoid float drift). NULL when the provider reports
 * no cost; those rows are estimated client-side from a static rate table.
 *
 * agentboster deliberately does NOT use a REFERENCES FK here (see AGENTS.md
 * "Database and Migration Rules" — no FK / cascade in this repo); cleanup
 * of usage rows on task deletion is the application's responsibility.
 */
export const taskUsage = pgTable(
  'task_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    userId: text('user_id'),
    provider: text('provider').notNull().default(''),
    model: text('model').notNull().default(''),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    /**
     * Provider-reported cost in 1e-10 USD ticks. NULL when the provider
     * reports none; those rows are estimated from a rate table. Why ticks:
     * xAI/Grok threshold-prices requests (2x past 200K prompt tokens) and
     * returns the authoritative figure as integer ticks — storing it keeps
     * sub-cent turn costs exact end-to-end instead of drifting through
     * float64. The column is read with `mode: 'number'`, so it surfaces as
     * a JS number; its safe ceiling is ~9.0e5 USD per row
     * (Number.MAX_SAFE_INTEGER ticks at 1e-10 USD/tick), which is
     * effectively unreachable for any single task.
     */
    costUsdTicks: bigint('cost_usd_ticks', { mode: 'number' }),
    /** Arbitrary provider-specific metadata (e.g. tier, rate-table version). */
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    taskProviderModelIdx: uniqueIndex('task_usage_task_provider_model_idx').on(
      table.taskId,
      table.provider,
      table.model,
    ),
    taskIdx: index('task_usage_task_id_idx').on(table.taskId),
    userIdIdx: index('task_usage_user_id_idx').on(table.userId),
  }),
);

/**
 * Per-node, per-day, per-(provider, model) token usage rollup.
 *
 * Ported from Multica migration 013. One row per distinct
 * (nodeId, date, provider, model). The UNIQUE constraint makes the
 * upsert idempotent: the same-day same-key report increments the row
 * instead of creating a duplicate. Date is stored as TEXT in ISO format
 * (`YYYY-MM-DD`) — Drizzle's `date` mode matches.
 *
 * Use this for daily spend dashboards and per-node capacity planning.
 */
export const nodeUsageDaily = pgTable(
  'node_usage_daily',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nodeId: text('node_id').notNull(),
    userId: text('user_id'),
    date: date('date').notNull(),
    provider: text('provider').notNull().default(''),
    model: text('model').notNull().default(''),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    costUsdTicks: bigint('cost_usd_ticks', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // NOTE: userId is part of the conflict key. Postgres treats NULL as
    // distinct (NULL != NULL), so a NULL userId would bypass the unique
    // constraint entirely and let same-key rows multiply instead of
    // upserting. The DAL coerces a missing userId to the sentinel
    // `'__shared__'` so anonymous/shared usage lands in its own bucket
    // and still hits this conflict target.
    nodeDateProviderModelIdx: uniqueIndex(
      'node_usage_daily_node_date_provider_model_idx',
    ).on(table.nodeId, table.userId, table.date, table.provider, table.model),
    nodeDateIdx: index('node_usage_daily_node_date_idx').on(
      table.nodeId,
      table.date,
    ),
    userIdIdx: index('node_usage_daily_user_id_idx').on(table.userId),
  }),
);
