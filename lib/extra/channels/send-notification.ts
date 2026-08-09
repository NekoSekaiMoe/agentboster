import { getNotificationPreferences } from '@/lib/core/db/notification';
import {
  isNotificationMuted,
  notifTypeToGroup,
} from '@/lib/core/notification/groups';
import { resolveUserLocale } from '@/lib/chat/user-locale';
import { getConfig } from '@/lib/core/kv/config';
import {
  normalizeLocale,
  defaultLocale,
  translate,
  type Locale,
  type TranslationKey,
} from '@/lib/i18n';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import { ensureNotificationChannels } from './register-channels';
import { getNotificationManager } from './notification-manager';
import type {
  NotificationPayload,
  NotificationLocale,
} from './notification-types';

const logger = createLogger('notification.send');

/**
 * Resolve the locale a notification should be rendered in.
 *
 * Precedence (top wins):
 *   1. Locale already on the payload (set by an upstream caller)
 *   2. The target user's most recent session.metadata.locale
 *   3. config.language?.bot_locale (global bot default)
 *   4. en-US (final fallback so templates always resolve)
 */
async function resolvePayloadLocale(
  payload: NotificationPayload,
  userId?: string,
): Promise<NotificationLocale> {
  if (payload.locale) return payload.locale;

  if (userId) {
    const userLocale = await resolveUserLocale(userId);
    if (userLocale) return userLocale;
  }

  const config = await getConfig();
  const configured = config.language?.bot_locale;
  if (configured && configured !== 'auto') {
    return normalizeLocale(configured);
  }

  return defaultLocale;
}

/**
 * If the payload carries a `titleKey` (set by agentd when it wants the
 * title localized server-side rather than passing a hard-coded English
 * string), translate it now that we know the rendering locale. The
 * original English `title` is kept as a fallback if the key is missing
 * from the locale table.
 *
 * Mutates `payload.title` only when a translation is available.
 */
function applyLocalizedTitle(
  payload: NotificationPayload,
  locale: Locale,
): void {
  const ext = payload as NotificationPayload & {
    titleKey?: string;
    titleValues?: Record<string, string | number>;
  };
  if (!ext.titleKey) return;
  try {
    const translated = translate(
      locale,
      ext.titleKey as TranslationKey,
      ext.titleValues,
    );
    if (translated && translated !== ext.titleKey) {
      payload.title = translated;
    }
  } catch (error) {
    logger.warn('localize_title_failed', {
      titleKey: ext.titleKey,
      locale,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Send a notification to the user via their preferred IM channel.
 * Automatically handles fallback to backup channels if the preferred one fails.
 */
export async function sendNotification(params: {
  source: ChatSource;
  payload: NotificationPayload;
  userId?: string;
}): Promise<{
  success: boolean;
  channel: string;
  error?: string;
  messageId?: string;
}> {
  const { source, payload, userId } = params;

  if (source.type !== 'im') {
    logger.warn('notification skipped: non-IM source', {
      sourceType: source.type,
    });
    return { success: false, channel: 'none', error: 'Non-IM source' };
  }

  const prefs = userId ? await getNotificationPreferences(userId) : null;
  const preferredChannel = prefs?.preferredChannel ?? source.adapter;
  const fallbackChannels = prefs?.fallbackChannels?.length
    ? prefs.fallbackChannels
    : [source.adapter];

  // Event-group mute: skip delivery entirely when the user has muted the
  // group this notification's type maps to. `decision` (L2 authorization)
  // is EXEMPT — it maps to the `action_required` group but a pending human
  // verdict must never be silenced, so we short-circuit mute for that type
  // regardless of prefs. Mirrors Multica's isNotifMuted + the security
  // invariant that authorization prompts always reach the user.
  if (
    payload.type !== 'decision' &&
    prefs?.mutedGroups &&
    isNotificationMuted({
      notificationType: payload.type,
      mutedGroups: prefs.mutedGroups,
    })
  ) {
    logger.info('notification muted by group preference', {
      userId,
      type: payload.type,
      group: notifTypeToGroup(payload.type),
    });
    return { success: true, channel: 'muted' };
  }

  // Resolve and stamp the rendering locale onto the payload before
  // dispatching. Channel renderers (Phase 2) read this instead of the
  // hard-coded text. The stamp is idempotent — already-set locales win.
  const locale = await resolvePayloadLocale(payload, userId);
  (payload as NotificationPayload & { locale: NotificationLocale }).locale =
    locale;

  // If agentd supplied a titleKey, localize the title now that we know
  // the rendering locale. Skipped silently when titleKey is absent.
  applyLocalizedTitle(payload, locale);

  // Lazily register notification channels from live config. Idempotent
  // — channels already registered with the same credentials are skipped.
  // Without this call the NotificationManager singleton has an empty
  // channels Map and every send (L2 prompts, task alerts) silently fails.
  const config = await getConfig();
  ensureNotificationChannels(config);

  const mgr = getNotificationManager();

  if (payload.type === 'decision') {
    const result = await mgr.sendL2Decision({
      taskId: payload.taskId,
      decisionId: payload.decisionId,
      title: payload.title,
      body: payload.body,
      command: payload.command,
      commandReview: payload.commandReview,
      score: payload.score,
      reason: payload.reason,
      preferredChannel,
      fallbackChannels,
      targetChatId: source.threadId,
      targetUserId: userId ?? source.userId ?? undefined,
    });

    logger.info('L2 decision notification sent', {
      taskId: payload.taskId,
      decisionId: payload.decisionId,
      channel: result.channel,
      success: result.success,
    });

    return {
      success: result.success,
      channel: result.channel,
      error: result.error,
      messageId: result.messageId,
    };
  }

  const result = await mgr.send({
    taskId:
      payload.type === 'workspace_failover'
        ? payload.workspaceId
        : payload.taskId,
    notificationType: payload.type,
    payload,
    preferredChannel,
    fallbackChannels,
    targetChatId: source.threadId,
    targetUserId: userId ?? source.userId ?? undefined,
  });

  logger.info('notification sent', {
    taskId:
      payload.type === 'workspace_failover'
        ? payload.workspaceId
        : payload.taskId,
    type: payload.type,
    channel: result.channel,
    success: result.success,
  });

  return {
    success: result.success,
    channel: result.channel,
    error: result.error,
    messageId: result.messageId,
  };
}

/**
 * Reactivate pending decisions when a user comes back online.
 * Called when the bot detects a user message on any IM channel.
 */
export async function reactivatePendingDecisions(params: {
  userId: string;
  source: ChatSource;
  pendingDecisions: Array<{
    decisionId: string;
    taskId: string;
    command: string;
    score: number;
    reason: string;
    sessionID?: string;
  }>;
}): Promise<void> {
  const { userId, source, pendingDecisions } = params;

  if (pendingDecisions.length === 0) return;

  if (source.type !== 'im') return;

  const prefs = await getNotificationPreferences(userId);
  const preferredChannel = prefs?.preferredChannel ?? source.adapter;
  const fallbackChannels = prefs?.fallbackChannels?.length
    ? prefs.fallbackChannels
    : [source.adapter];

  const mgr = getNotificationManager();
  await mgr.markUserOnline(userId);

  // Ensure channels are registered (same lazy init as sendNotification).
  const config = await getConfig();
  ensureNotificationChannels(config);

  await mgr.reactivatePendingDecisions(
    pendingDecisions,
    preferredChannel,
    fallbackChannels,
    source.threadId,
    userId,
  );

  logger.info('Reactivated pending decisions', {
    userId,
    count: pendingDecisions.length,
  });
}
