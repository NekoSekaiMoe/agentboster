import type { ChannelsConfig } from '@/types/config/channels';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createGoogleChatAdapter } from '@chat-adapter/gchat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createTeamsAdapter } from '@chat-adapter/teams';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Client as FeishuClient } from '@larksuiteoapi/node-sdk';
import { Bot as QQBot, ReceiverMode } from 'qq-official-bot';

type BotAdapters = {
  discord?: ReturnType<typeof createDiscordAdapter>;
  gchat?: ReturnType<typeof createGoogleChatAdapter>;
  slack?: ReturnType<typeof createSlackAdapter>;
  teams?: ReturnType<typeof createTeamsAdapter>;
  telegram?: ReturnType<typeof createTelegramAdapter>;
  feishu?: FeishuClient;
  qq?: QQBot;
};

type ExtraAdapters = {
  feishuEvents?: {
    encryptKey?: string;
    verificationToken?: string;
  };
  qqWebhook?: {
    port?: number;
    path?: string;
  };
};

export function createBotAdapters(channels?: ChannelsConfig): BotAdapters {
  const adapters: BotAdapters = {};

  if (channels?.telegram?.enabled) {
    const cfg = channels.telegram;
    adapters.telegram = createTelegramAdapter({
      ...(cfg.bot_token ? { botToken: cfg.bot_token } : {}),
      ...(cfg.secret_token ? { secretToken: cfg.secret_token } : {}),
      ...(cfg.bot_username ? { userName: cfg.bot_username } : {}),
      ...(cfg.api_base_url ? { apiBaseUrl: cfg.api_base_url } : {}),
    });
  }

  if (channels?.discord?.enabled) {
    const cfg = channels.discord;
    if (cfg.bot_token) {
      adapters.discord = createDiscordAdapter({
        botToken: cfg.bot_token,
        ...(cfg.application_id ? { applicationId: cfg.application_id } : {}),
        ...(cfg.public_key ? { publicKey: cfg.public_key } : {}),
      });
    }
  }

  if (channels?.slack?.enabled) {
    const cfg = channels.slack;
    adapters.slack = createSlackAdapter({
      ...(cfg.bot_token ? { botToken: cfg.bot_token } : {}),
      ...(cfg.signing_secret ? { signingSecret: cfg.signing_secret } : {}),
      ...(cfg.client_id ? { clientId: cfg.client_id } : {}),
      ...(cfg.client_secret ? { clientSecret: cfg.client_secret } : {}),
      ...(cfg.encryption_key ? { encryptionKey: cfg.encryption_key } : {}),
    });
  }

  if (channels?.teams?.enabled) {
    const cfg = channels.teams;
    adapters.teams = createTeamsAdapter({
      ...(cfg.app_id ? { appId: cfg.app_id } : {}),
      ...(cfg.app_password ? { appPassword: cfg.app_password } : {}),
    });
  }

  if (channels?.gchat?.enabled) {
    const cfg = channels.gchat;
    adapters.gchat = createGoogleChatAdapter({
      ...(cfg.project_id ? { projectId: cfg.project_id } : {}),
      ...(cfg.credentials_json
        ? { credentials: JSON.parse(cfg.credentials_json) }
        : {}),
    });
  }

  // Feishu and QQ use their own SDKs, not Chat SDK adapters
  // They are initialized separately in createExtraAdapters

  return adapters;
}

export function createExtraAdapters(channels?: ChannelsConfig): ExtraAdapters {
  const extra: ExtraAdapters = {};

  if (channels?.feishu?.enabled) {
    const cfg = channels.feishu;
    extra.feishuEvents = {
      encryptKey: cfg.encrypt_key || undefined,
      verificationToken: cfg.verification_token || undefined,
    };
  }

  if (channels?.qq?.enabled) {
    const cfg = channels.qq;
    extra.qqWebhook = {
      port: 3001,
      path: '/api/bot/qq/callback',
    };
  }

  return extra;
}
