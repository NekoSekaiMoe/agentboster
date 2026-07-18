import {
  boolean,
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
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
