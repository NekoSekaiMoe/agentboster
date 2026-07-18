import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './chat';

export const scheduledTasks = pgTable('scheduled_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id')
    .references(() => sessions.id, { onDelete: 'cascade' })
    .notNull(),
  type: text('type', { enum: ['delay', 'daily'] }).notNull(),
  title: text('title'),
  prompt: text('prompt').notNull(),
  timezone: text('timezone'),
  dailyTime: text('daily_time'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
  lastFiredFor: timestamp('last_fired_for', { withTimezone: true }),
  scheduleWorkflowRunId: text('schedule_workflow_run_id'),
  lastChatRunId: text('last_chat_run_id'),
  active: boolean('active').default(true).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  // Notification routing for task-triggered outcomes.
  // - null/'default': follow the user's notification_preferences
  // - 'desktop':     push to the online Desktop client (system notification)
  // - 'im:auto':     use user's preferredChannel (IM)
  // - 'im:<adapter>':force a specific IM adapter (telegram/discord/slack/feishu/...)
  notifyChannel: text('notify_channel'),
  // When true, the dispatched chat run is routed through the user's
  // online CLI remote-control session so the LLM can use local_* and
  // computer-use tools on the user's physical machine. When false or
  // null, the task runs on whatever backend session it was attached to.
  remoteControl: boolean('remote_control').default(false),
  // Node routing constraints for the dispatched chat run. Only relevant
  // when the task triggers a backend execution path that uses agentd
  // (i.e. `remoteControl` is false — true routes to the user's CLI).
  //
  // - `preferred_node_id`: explicit "must run on this daemon" choice.
  //   When the node is unreachable the task fails (counted toward
  //   `failure_count`), unless `auto_fallback_node` is true and a
  //   candidate from `allowed_nodes` is reachable.
  // - `allowed_nodes`: candidate pool for auto-fallback. Empty/null
  //   means "no fallback" — preferred node failure is terminal.
  // - `auto_fallback_node`: when true, dispatch falls back to the best
  //   reachable node in `allowed_nodes` when `preferred_node_id` is
  //   unreachable. Default false (preferred-node-failure is terminal).
  preferredNodeId: text('preferred_node_id'),
  allowedNodes: text('allowed_nodes').array(),
  autoFallbackNode: boolean('auto_fallback_node').default(false).notNull(),
  // Consecutive failure tracking. Incremented on each failed dispatch
  // (node unreachable, chatMain error, etc.); reset to 0 on any success.
  // When it reaches MAX_SCHEDULE_FAILURES (3) the task is auto-disabled
  // (`active=false`, `disabled_by_failure=true`) and a failure
  // notification is sent. The user re-enabling the task (PATCH active=
  // true) clears both fields so the counter restarts from zero.
  failureCount: integer('failure_count').default(0).notNull(),
  disabledByFailure: boolean('disabled_by_failure').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
