import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title'),
    channel: text('channel').default('web').notNull(),
    channelOrigin: text('channel_origin'),
    externalThreadId: text('external_thread_id'),
    userId: text('user_id'),
    /** Workspace this session belongs to. Backfilled for legacy rows. */
    workspaceId: uuid('workspace_id'),
    /**
     * Only meaningful inside a PUBLIC workspace: 'private' (default) is
     * visible to the creator only (workspace owner/admin may manage —
     * rename/delete — but not read content); 'shared' is visible and
     * manageable by every workspace member.
     */
    visibility: text('visibility', { enum: ['private', 'shared'] })
      .default('private')
      .notNull(),
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

    // ── Session Goal (self-driving loop) ───────────────────────────────
    // See lib/workflow/agent/session-goal.ts for the evaluator + the
    // four-condition continuation gate. These five columns are the
    // persisted counters/state the gate reads; a new goal (setSessionGoal)
    // resets hidden_continuation_count / consecutive_non_progress /
    // last_eval_reason to a fresh start.

    /** Free-text objective the agent works toward. Null = no goal set,
     *  so the whole self-driving loop is skipped. ≤
     *  MAX_GOAL_OBJECTIVE_CHARS enforced at the DAL edge. */
    goalText: text('goal_text'),
    /** When the current goal was set. Cleared on /goal clear. */
    goalSetAt: timestamp('goal_set_at', { withTimezone: true }),
    /** Hidden auto-continuations issued for THIS goal. Bounded by
     *  MAX_HIDDEN_CONTINUATIONS (8); reset to 0 on setSessionGoal. */
    hiddenContinuationCount: integer('hidden_continuation_count')
      .default(0)
      .notNull(),
    /** Consecutive identical non-progress evaluations for THIS goal.
     *  Bounded by MAX_IDENTICAL_NON_PROGRESS (2); reset on
     *  setSessionGoal and whenever the eval reason changes. */
    consecutiveNonProgress: integer('consecutive_non_progress')
      .default(0)
      .notNull(),
    /** The last evaluation.reasoning recorded. Lets the UI surface why
     *  the loop stopped, and lets incrementGoalCounters detect the
     *  "same reason twice" breaker condition. */
    lastEvalReason: text('last_eval_reason'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdx: index('sessions_workspace_idx').on(table.workspaceId),
    /** Covers listVisibleSessions' workspace-scoped hot path:
     *  WHERE workspace_id = ? AND archived = ? ORDER BY updated_at DESC. */
    workspaceArchivedUpdatedIdx: index(
      'sessions_workspace_archived_updated_idx',
    ).on(table.workspaceId, table.archived, table.updatedAt),
  }),
);

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
  (table) => {
    const traceRunId = sql`(${table.payload}->'metadata'->>'runId')`;
    return {
      sessionUiMessageIdIdx: uniqueIndex(
        'messages_session_ui_message_id_idx',
      ).on(table.sessionId, table.uiMessageId),
      traceRunCreatedIdx: index('messages_trace_run_created_idx')
        .on(traceRunId, table.createdAt)
        .concurrently()
        .where(sql`${traceRunId} IS NOT NULL`),
    };
  },
);

export type ChatSession = typeof sessions.$inferSelect;
