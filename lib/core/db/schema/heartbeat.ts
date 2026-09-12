import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './chat';

/**
 * Per-session heartbeat configuration — the agentboster port of arkloop's
 * LLM Heartbeat (ref/arkloop src/services/worker/internal/desktoprun/
 * llm_heartbeat_scheduler.go + mw_llm_heartbeat.go).
 *
 * A heartbeat is a scheduled agent wake-up on an (IM) session that asks
 * exactly one question first: "should I proactively speak in this thread,
 * or stay silent?" The decision is made by the model via the forced
 * heartbeat_decision tool call (see
 * lib/workflow/agent/tools/heartbeat/decision.ts); only a `reply: true`
 * decision produces output, which is delivered to the session's own IM
 * thread.
 *
 * One row per session (session_id is the PK). Rows without `enabled` have
 * no wake-up workflow; `next_run_at` is maintained by the dispatcher
 * (advance-on-dispatch, not advance-on-completion — a slow or failed run
 * must not double-fire the slot).
 */
export const sessionHeartbeats = pgTable('session_heartbeats', {
  // PK == the session this heartbeat wakes. cascade: deleting the session
  // removes its heartbeat state with it.
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(true).notNull(),
  /** Minutes between wake-ups. Clamped to [5, 1440] on write. */
  intervalMinutes: integer('interval_minutes').default(30).notNull(),
  /** Next due wake-up. Null when disabled. Maintained advance-on-dispatch. */
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  /** Last wake-up actually dispatched. */
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  /** When the last decision was recorded (reply true/false). */
  lastDecisionAt: timestamp('last_decision_at', { withTimezone: true }),
  /** The last decision itself — null = spoke (reply true). */
  lastDecisionReply: boolean('last_decision_reply'),
  /** The chat run the last wake-up produced. */
  lastChatRunId: text('last_chat_run_id'),
  /** The wake-up workflow run id (the sleeping loop, arkloop-style). */
  heartbeatWorkflowRunId: text('heartbeat_workflow_run_id'),
  /** Consecutive dispatch failures (auto-disable guard, mirroring
   *  scheduled_tasks.failure_count semantics). */
  failureCount: integer('failure_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type SessionHeartbeat = typeof sessionHeartbeats.$inferSelect;
export type NewSessionHeartbeat = typeof sessionHeartbeats.$inferInsert;
