/**
 * Lazy registration of notification channels from live config.
 *
 * NotificationManager is a zero-arg singleton, so it cannot register
 * channels in its constructor — it does not have access to AppConfig.
 * Previously nothing else called registerChannel either, which meant
 * the channels Map was always empty and every notification send
 * (L2 prompts, task alerts) silently failed with "no channel
 * registered".
 *
 * ensureNotificationChannels() is the fix. Call it from any entry
 * point that already holds AppConfig (sendNotification, the l2-confirm
 * route, ...). It is idempotent: channels are registered at most once
 * per (type, config-fingerprint), so repeat calls are cheap and safe.
 */

import type { AppConfig } from '@/types/config';
import { DiscordNotificationChannel } from './notifications/discord';
import { FeishuNotificationChannel } from './notifications/feishu';
import { GChatNotificationChannel } from './notifications/gchat';
import { QQNotificationChannel } from './notifications/qq';
import { SlackNotificationChannel } from './notifications/slack';
import { TeamsNotificationChannel } from './notifications/teams';
import { TelegramNotificationChannel } from './notifications/telegram';
import { getNotificationManager } from './notification-manager';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('notification.register');

/**
 * Fingerprint of the credentials relevant to a channel, so a config
 * change (e.g. bot token rotated) triggers re-registration.
 */
function channelFingerprint(channel: unknown): string {
  if (!channel || typeof channel !== 'object') return '';
  const c = channel as Record<string, unknown>;
  return JSON.stringify({
    bot_token: c.bot_token,
    app_id: c.app_id,
    app_password: c.app_password,
    appid: c.appid,
    secret: c.secret,
    app_secret: c.app_secret,
    project_id: c.project_id,
    credentials_json: c.credentials_json,
  });
}

const registeredFingerprints = new Map<string, string>();

/**
 * Register every enabled, healthy notification channel into the
 * NotificationManager singleton. Safe to call repeatedly — channels
 * whose fingerprint has not changed are skipped.
 *
 * Returns the list of channel types that are currently registered
 * after this call (useful for logging).
 */
export function ensureNotificationChannels(config: AppConfig): string[] {
  const mgr = getNotificationManager();
  const channels = config.channels ?? {};

  const candidates: Array<{
    type: string;
    enabled: boolean;
    fingerprint: string;
    factory: () => void;
  }> = [];

  if (channels.telegram) {
    candidates.push({
      type: 'telegram',
      enabled: !!channels.telegram.enabled,
      fingerprint: channelFingerprint(channels.telegram),
      factory: () =>
        mgr.registerChannel(
          new TelegramNotificationChannel({
            botToken: channels.telegram?.bot_token ?? '',
          }),
        ),
    });
  }

  if (channels.discord) {
    candidates.push({
      type: 'discord',
      enabled: !!channels.discord.enabled,
      fingerprint: channelFingerprint(channels.discord),
      factory: () =>
        mgr.registerChannel(
          new DiscordNotificationChannel({
            botToken: channels.discord?.bot_token ?? '',
          }),
        ),
    });
  }

  if (channels.slack) {
    candidates.push({
      type: 'slack',
      enabled: !!channels.slack.enabled,
      fingerprint: channelFingerprint(channels.slack),
      factory: () =>
        mgr.registerChannel(
          new SlackNotificationChannel({
            botToken: channels.slack?.bot_token ?? '',
          }),
        ),
    });
  }

  if (channels.feishu) {
    candidates.push({
      type: 'feishu',
      enabled: !!channels.feishu.enabled,
      fingerprint: channelFingerprint(channels.feishu),
      factory: () =>
        mgr.registerChannel(
          new FeishuNotificationChannel({
            appId: channels.feishu?.app_id ?? '',
            appSecret: channels.feishu?.app_secret ?? '',
          }),
        ),
    });
  }

  if (channels.gchat) {
    candidates.push({
      type: 'gchat',
      enabled: !!channels.gchat.enabled,
      fingerprint: channelFingerprint(channels.gchat),
      factory: () =>
        mgr.registerChannel(
          new GChatNotificationChannel({
            projectId: channels.gchat?.project_id ?? '',
            credentialsJson: channels.gchat?.credentials_json ?? '',
          }),
        ),
    });
  }

  if (channels.teams) {
    candidates.push({
      type: 'teams',
      enabled: !!channels.teams.enabled,
      fingerprint: channelFingerprint(channels.teams),
      factory: () =>
        mgr.registerChannel(
          new TeamsNotificationChannel({
            appId: channels.teams?.app_id ?? '',
            appPassword: channels.teams?.app_password ?? '',
          }),
        ),
    });
  }

  if (channels.qq) {
    candidates.push({
      type: 'qq',
      enabled: !!channels.qq.enabled,
      fingerprint: channelFingerprint(channels.qq),
      factory: () =>
        mgr.registerChannel(
          new QQNotificationChannel({
            appId: channels.qq?.appid ?? '',
            appSecret: channels.qq?.secret ?? '',
          }),
        ),
    });
  }

  let newlyRegistered = 0;
  for (const c of candidates) {
    if (!c.enabled) continue;
    const current = registeredFingerprints.get(c.type);
    if (current === c.fingerprint) continue; // already registered with same creds
    c.factory();
    registeredFingerprints.set(c.type, c.fingerprint);
    newlyRegistered++;
  }

  if (newlyRegistered > 0) {
    logger.info('notification channels ensured', {
      registered: newlyRegistered,
      types: mgr.getRegisteredTypes(),
    });
  }

  return mgr.getRegisteredTypes();
}
