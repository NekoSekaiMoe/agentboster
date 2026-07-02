import { z } from 'zod';

/**
 * Chat SDK Adapter
 * https://chat-sdk.dev/docs/adapters
 *
 * Supported Adapters: Slack, Teams, Google Chat, Telegram, Discord
 * Each adapter is initialized with environment variables or configuration parameters and receives messages through webhooks.
 */

/**
 * Common base adapter configuration
 */
const baseAdapterConfigSchema = z.object({
  /** Whether this adapter is enabled */
  enabled: z.boolean().default(false),
  /** Author user IDs allowed to enter the main chat flow */
  allowed_author_ids: z.array(z.string().trim().min(1)).optional(),
  /** Whether LLM replies should be sent as voice messages instead of (or alongside) text. Falls back to text on platforms that lack audio support. Defaults to false. */
  tts_enabled: z.boolean().optional(),
  /** Per-channel TTS voice override. If unset, falls back to the global tts.voice. */
  tts_voice: z.string().optional(),
});

/**
 * Slack adapter configuration
 * @see https://chat-sdk.dev/docs/adapters/slack
 */
export const slackAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Slack Bot Token (xoxb-...) - single-workspace mode */
  bot_token: z.string().optional(),
  /** Slack Signing Secret - webhook signature verification */
  signing_secret: z.string().optional(),
  /** Slack Client ID - multi-workspace OAuth mode */
  client_id: z.string().optional(),
  /** Slack Client Secret - multi-workspace OAuth mode */
  client_secret: z.string().optional(),
  /** Encryption key (AES-256-GCM) */
  encryption_key: z.string().optional(),
});

export type SlackAdapterConfig = z.infer<typeof slackAdapterConfigSchema>;

/**
 * Microsoft Teams adapter configuration
 * @see https://chat-sdk.dev/docs/adapters/teams
 */
export const teamsAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Azure Bot App ID */
  app_id: z.string().optional(),
  /** Azure Bot App Password */
  app_password: z.string().optional(),
});

export type TeamsAdapterConfig = z.infer<typeof teamsAdapterConfigSchema>;

/**
 * Google Chat adapter configuration
 * @see https://chat-sdk.dev/docs/adapters/gchat
 */
export const gchatAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Google Cloud project ID */
  project_id: z.string().optional(),
  /** Service account credentials JSON */
  credentials_json: z.string().optional(),
});

export type GChatAdapterConfig = z.infer<typeof gchatAdapterConfigSchema>;

/**
 * Telegram adapter configuration
 * @see https://chat-sdk.dev/docs/adapters/telegram
 */
export const telegramAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Telegram Bot Token */
  bot_token: z.string().optional(),
  /** Webhook Secret Token */
  secret_token: z.string().optional(),
  /** Bot username (used for mention detection) */
  bot_username: z.string().optional(),
  /** Custom API base URL (used when self-hosting an API gateway) */
  api_base_url: z.string().optional(),
});

export type TelegramAdapterConfig = z.infer<typeof telegramAdapterConfigSchema>;

/**
 * Discord adapter configuration
 * @see https://chat-sdk.dev/docs/adapters/discord
 */
export const discordAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Discord Bot Token */
  bot_token: z.string().optional(),
  /** Discord Application ID */
  application_id: z.string().optional(),
  /** Public key for interaction verification */
  public_key: z.string().optional(),
});

export type DiscordAdapterConfig = z.infer<typeof discordAdapterConfigSchema>;

/**
 * Feishu/Lark adapter configuration
 */
export const feishuAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Feishu App ID */
  app_id: z.string().optional(),
  /** Feishu App Secret */
  app_secret: z.string().optional(),
  /** Encrypt key (optional, for event encryption) */
  encrypt_key: z.string().optional(),
  /** Verification token (optional, for event verification) */
  verification_token: z.string().optional(),
  /** Domain: feishu.cn or larksuite.com */
  domain: z.enum(['feishu', 'lark']).optional(),
});

export type FeishuAdapterConfig = z.infer<typeof feishuAdapterConfigSchema>;

/**
 * QQ Official Bot adapter configuration
 */
export const qqAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** QQ Bot App ID */
  appid: z.string().optional(),
  /** QQ Bot App Secret */
  secret: z.string().optional(),
  /** Sandbox mode */
  sandbox: z.boolean().optional(),
  /** Intents to subscribe (comma-separated) */
  intents: z.string().optional(),
});

export type QQAdapterConfig = z.infer<typeof qqAdapterConfigSchema>;

/**
 * WeChat Work (WeCom / 企业微信) smart-bot adapter configuration.
 *
 * WeCom smart bots (智能机器人, see WeCom developer docs section 101039)
 * support two receive modes — Webhook (HTTP callback) and WebSocket
 * long-connection. This adapter only implements the Webhook mode because
 * long-connection requires a persistent process (incompatible with
 * Vercel serverless). The two modes have completely separate credential
 * sets, so the schema below exposes both as optional and the adapter
 * factory picks whichever set is filled in.
 *
 * Webhook mode credentials:
 *   corp_id, secret, token, encoding_aes_key
 *
 * For notification push (single-direction, like L2 decisions), we also
 * use corp_id + secret + agent_id to call the application-messaging API
 * (qyapi.weixin.qq.com/cgi-bin/message/send). That's distinct from the
 * smart-bot reply API (qyapi.weixin.qq.com/cgi-bin/aibot/response) and
 * has its own quota (account_size × 200 msgs/day per app, 30/min and
 * 1000/hour per recipient) — see doc 90236.
 */
export const wecomAdapterConfigSchema = baseAdapterConfigSchema.extend({
  /** Corporation ID (from WeCom admin console). */
  corp_id: z.string().optional(),
  /** Application secret (used to exchange for access_token). */
  secret: z.string().optional(),
  /** Application agent_id (integer as string; required for app-message push). */
  agent_id: z.string().optional(),
  /** Signature verification token for webhook mode (self-chosen, set in WeCom console). */
  token: z.string().optional(),
  /** 43-char base64 EncodingAESKey for webhook-mode AES-256-CBC decryption. */
  encoding_aes_key: z.string().optional(),
});

export type WecomAdapterConfig = z.infer<typeof wecomAdapterConfigSchema>;

/**
 * Aggregate configuration schema for all channels/adapters
 * Aligned with the Chat SDK Adapter system
 */
export const channelsConfigSchema = z.object({
  /** Telegram adapter configuration */
  telegram: telegramAdapterConfigSchema.optional(),
  /** Discord adapter configuration */
  discord: discordAdapterConfigSchema.optional(),
  /** Slack adapter configuration */
  slack: slackAdapterConfigSchema.optional(),
  /** Microsoft Teams adapter configuration */
  teams: teamsAdapterConfigSchema.optional(),
  /** Google Chat adapter configuration */
  gchat: gchatAdapterConfigSchema.optional(),
  /** Feishu/Lark adapter configuration */
  feishu: feishuAdapterConfigSchema.optional(),
  /** QQ Official Bot adapter configuration */
  qq: qqAdapterConfigSchema.optional(),
  /** WeChat Work (WeCom) smart-bot adapter configuration */
  wecom: wecomAdapterConfigSchema.optional(),
});

export type ChannelsConfig = z.infer<typeof channelsConfigSchema>;

/**
 * Supported adapter names
 */
export const ADAPTER_NAMES = [
  'telegram',
  'discord',
  'slack',
  'teams',
  'gchat',
  'feishu',
  'qq',
  'wecom',
] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];
