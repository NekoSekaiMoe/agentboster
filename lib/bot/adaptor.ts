import type { ChannelsConfig } from '@/types/config/channels';
import type { Adapter } from 'chat';
export {
  getBotCapabilities,
  type BotCapabilities,
} from './capabilities';

type ChatSdkAdapterName =
  | 'discord'
  | 'gchat'
  | 'slack'
  | 'teams'
  | 'telegram'
  | 'feishu'
  | 'qq';

type BotAdapters = Partial<Record<ChatSdkAdapterName, Adapter>>;

export async function createBotAdapters(
  channels?: ChannelsConfig,
): Promise<BotAdapters> {
  const adapters: BotAdapters = {};

  if (channels?.telegram?.enabled) {
    const { createTelegramAdapter } = await import('@chat-adapter/telegram');
    const cfg = channels.telegram;
    adapters.telegram = createTelegramAdapter({
      ...(cfg.bot_token ? { botToken: cfg.bot_token } : {}),
      ...(cfg.secret_token ? { secretToken: cfg.secret_token } : {}),
      ...(cfg.bot_username ? { userName: cfg.bot_username } : {}),
      ...(cfg.api_base_url ? { apiBaseUrl: cfg.api_base_url } : {}),
    });
  }

  if (channels?.discord?.enabled) {
    const { createDiscordAdapter } = await import('@chat-adapter/discord');
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
    const { createSlackAdapter } = await import('@chat-adapter/slack');
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
    const { createTeamsAdapter } = await import('@chat-adapter/teams');
    const cfg = channels.teams;
    adapters.teams = createTeamsAdapter({
      ...(cfg.app_id ? { appId: cfg.app_id } : {}),
      ...(cfg.app_password ? { appPassword: cfg.app_password } : {}),
    });
  }

  if (channels?.gchat?.enabled) {
    const { createGoogleChatAdapter } = await import('@chat-adapter/gchat');
    const cfg = channels.gchat;
    adapters.gchat = createGoogleChatAdapter({
      ...(cfg.project_id ? { projectId: cfg.project_id } : {}),
      ...(cfg.credentials_json
        ? { credentials: JSON.parse(cfg.credentials_json) }
        : {}),
    });
  }

  // Feishu/QQ don't have @chat-adapter packages, so we register lightweight
  // Adapter shims (lib/bot/feishu-adapter.ts, lib/bot/qq-adapter.ts) that
  // implement postMessage/editMessage against each platform's REST API.
  // Without these, bot.getAdapter('feishu' | 'qq') returns undefined and
  // every outbound IM path (im-stream, reply, voice fallback) NPEs even
  // though inbound routing works. See lib/bot/adaptor.ts header.
  if (channels?.feishu?.enabled) {
    const { asFeishuAdapter } = await import('./feishu-adapter');
    const cfg = channels.feishu;
    if (cfg.app_id && cfg.app_secret) {
      adapters.feishu = asFeishuAdapter({
        appId: cfg.app_id,
        appSecret: cfg.app_secret,
      });
    }
  }

  if (channels?.qq?.enabled) {
    const { asQQAdapter } = await import('./qq-adapter');
    const cfg = channels.qq;
    if (cfg.appid && cfg.secret) {
      adapters.qq = asQQAdapter({
        appId: cfg.appid,
        appSecret: cfg.secret,
      });
    }
  }

  return adapters;
}
