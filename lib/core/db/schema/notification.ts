import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: text('task_id').notNull(),
  decisionId: text('decision_id'),
  notificationType: text('notification_type', {
    enum: ['decision', 'completion', 'tidy_report'],
  }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status', {
    enum: ['pending', 'sent', 'delivered', 'failed', 'fallback', 'expired'],
  })
    .default('pending')
    .notNull(),
  channel: text('channel').notNull(),
  targetChatId: text('target_chat_id').notNull(),
  targetUserId: text('target_user_id'),
  errorMessage: text('error_message'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').primaryKey(),
  preferredChannel: text('preferred_channel').notNull(),
  fallbackChannels: jsonb('fallback_channels')
    .$type<string[]>()
    .default([])
    .notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const channelHealth = pgTable('channel_health', {
  channel: text('channel').primaryKey(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  lastError: text('last_error'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  healthy: boolean('healthy').default(true).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
