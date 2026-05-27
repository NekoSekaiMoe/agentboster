import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './index';
import {
  channelHealth,
  notificationPreferences,
  notifications,
} from './schema';

// ─── Notifications ──────────────────────────────────────────────────

export async function createNotification(data: {
  taskId: string;
  decisionId?: string;
  notificationType: 'decision' | 'completion' | 'tidy_report';
  payload: Record<string, unknown>;
  channel: string;
  targetChatId: string;
  targetUserId?: string;
  expiresAt?: Date;
}) {
  const [n] = await db
    .insert(notifications)
    .values({
      taskId: data.taskId,
      decisionId: data.decisionId ?? null,
      notificationType: data.notificationType,
      payload: data.payload,
      status: 'pending',
      channel: data.channel,
      targetChatId: data.targetChatId,
      targetUserId: data.targetUserId ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  return n;
}

export async function getNotification(id: string) {
  const [n] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id));
  return n ?? null;
}

export async function updateNotificationStatus(
  id: string,
  status: (typeof notifications.status.enumValues)[number],
  extra?: { errorMessage?: string; sentAt?: Date; deliveredAt?: Date },
) {
  const [n] = await db
    .update(notifications)
    .set({
      status,
      errorMessage: extra?.errorMessage ?? null,
      sentAt: extra?.sentAt ?? null,
      deliveredAt: extra?.deliveredAt ?? null,
    })
    .where(eq(notifications.id, id))
    .returning();
  return n;
}

export async function findPendingNotifications(taskId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.taskId, taskId),
        eq(
          notifications.notificationType,
          type as 'decision' | 'completion' | 'tidy_report',
        ),
        eq(notifications.status, 'pending'),
      ),
    );
}

export async function findNotificationByDedupKey(
  taskId: string,
  type: string,
  channel: string,
) {
  const [n] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.taskId, taskId),
        eq(
          notifications.notificationType,
          type as 'decision' | 'completion' | 'tidy_report',
        ),
        eq(notifications.channel, channel),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return n ?? null;
}

export async function listFailedNotifications(limit = 50) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.status, 'failed'))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

// ─── Notification Preferences ───────────────────────────────────────

export async function getNotificationPreferences(userId: string) {
  const [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  return prefs ?? null;
}

export async function upsertNotificationPreferences(data: {
  userId: string;
  preferredChannel: string;
  fallbackChannels: string[];
  enabled?: boolean;
}) {
  const [prefs] = await db
    .insert(notificationPreferences)
    .values({
      userId: data.userId,
      preferredChannel: data.preferredChannel,
      fallbackChannels: data.fallbackChannels,
      enabled: data.enabled ?? true,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: {
        preferredChannel: data.preferredChannel,
        fallbackChannels: data.fallbackChannels,
        enabled: data.enabled ?? true,
      },
    })
    .returning();
  return prefs;
}

// ─── Channel Health ─────────────────────────────────────────────────

export async function getChannelHealth(channel: string) {
  const [h] = await db
    .select()
    .from(channelHealth)
    .where(eq(channelHealth.channel, channel));
  return h ?? null;
}

export async function getAllChannelHealth() {
  return db.select().from(channelHealth);
}

export async function recordChannelSuccess(channel: string) {
  const [h] = await db
    .insert(channelHealth)
    .values({
      channel,
      consecutiveFailures: 0,
      healthy: true,
      lastSuccessAt: new Date(),
    })
    .onConflictDoUpdate({
      target: channelHealth.channel,
      set: {
        consecutiveFailures: 0,
        healthy: true,
        lastSuccessAt: new Date(),
        lastError: null,
      },
    })
    .returning();
  return h;
}

export async function recordChannelFailure(channel: string, error: string) {
  const [h] = await db
    .insert(channelHealth)
    .values({
      channel,
      consecutiveFailures: 1,
      healthy: true, // will be corrected below if needed
      lastError: error,
      lastFailureAt: new Date(),
    })
    .onConflictDoUpdate({
      target: channelHealth.channel,
      set: {
        consecutiveFailures: sql`${channelHealth.consecutiveFailures} + 1`,
        lastError: error,
        lastFailureAt: new Date(),
      },
    })
    .returning();

  // Update healthy flag based on final failure count
  if (h) {
    const healthy = h.consecutiveFailures < 3;
    if (h.healthy !== healthy) {
      await db
        .update(channelHealth)
        .set({ healthy })
        .where(eq(channelHealth.channel, channel));
    }
  }

  return h;
}
