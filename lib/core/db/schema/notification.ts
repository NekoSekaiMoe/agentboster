import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * The agentboster user who OWNS this notification (the subject of the
     * event, derived server-side from the task/session owner). This is the
     * column every list/mutation query MUST filter on for per-user
     * isolation. Distinct from `targetUserId` below, which is the IM
     * delivery target (an external platform id) and is NOT a tenancy
     * boundary.
     */
    userId: text('user_id'),
    taskId: text('task_id').notNull(),
    decisionId: text('decision_id'),
    notificationType: text('notification_type', {
      enum: ['decision', 'completion', 'tidy_report'],
    }).notNull(),
    /**
     * Triage severity. `action_required` surfaces in the inbox's
     * urgent lane; `attention` is the default; `info` is FYI. Ported
     * from Multica's inbox_item.severity (migration 001) — gives the
     * inbox a prioritization axis beyond the delivery status.
     */
    severity: text('severity', {
      enum: ['action_required', 'attention', 'info'],
    })
      .default('attention')
      .notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', {
      enum: ['pending', 'sent', 'delivered', 'failed', 'fallback', 'expired'],
    })
      .default('pending')
      .notNull(),
    /** When the user marked this notification as read (inbox triage). */
    readAt: timestamp('read_at', { withTimezone: true }),
    /** When the user archived this notification (inbox triage). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    channel: text('channel').notNull(),
    targetChatId: text('target_chat_id').notNull(),
    /**
     * IM-platform user id the notification is delivered to (e.g. Telegram
     * `from.id`). Advisory; NOT a tenancy boundary — use `userId` for
     * per-user filtering. Kept because the IM adapter needs the platform
     * id to address the message, and it may differ from the owner (e.g.
     * an admin acting on behalf of a user).
     */
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
  },
  (table) => ({
    userIdIdx: index('notifications_user_id_idx').on(table.userId),
    userUnreadIdx: index('notifications_user_unread_idx')
      .on(table.userId, table.readAt)
      .where(sql`${table.readAt} IS NULL`),
    userUnarchivedIdx: index('notifications_user_unarchived_idx')
      .on(table.userId, table.archivedAt)
      .where(sql`${table.archivedAt} IS NULL`),
  }),
);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').primaryKey(),
  preferredChannel: text('preferred_channel').notNull(),
  fallbackChannels: jsonb('fallback_channels')
    .$type<string[]>()
    .default([])
    .notNull(),
  /**
   * Event-type groups the user has muted (e.g. ['agent_activity',
   * 'updates']). Mapped from notification_type via notifTypeToGroup()
   * at delivery time. Empty/null means 'nothing muted'. Ported from
   * Multica's notification_preferences JSONB + isNotifMuted() pattern.
   */
  mutedGroups: jsonb('muted_groups').$type<string[]>().default([]).notNull(),
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
