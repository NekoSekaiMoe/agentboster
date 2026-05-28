import type { ChannelsConfig } from '@/types/config/channels';

export interface ChannelPreset {
  label: string;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder: string;
    required: boolean;
    help?: string;
  }>;
  apply: (config: Record<string, string>) => Partial<ChannelsConfig>;
}

export const CHANNEL_PRESETS: Record<string, ChannelPreset> = {
  telegram: {
    label: 'Telegram',
    description: 'Telegram Bot API — most common for personal/small team use',
    fields: [
      {
        key: 'bot_token',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        required: true,
        help: 'Get from @BotFather → /newbot',
      },
      {
        key: 'bot_username',
        label: 'Bot Username',
        placeholder: 'my_clawless_bot',
        required: false,
        help: 'Without @ prefix. Used for mention detection.',
      },
      {
        key: 'secret_token',
        label: 'Secret Token',
        placeholder: 'Optional webhook secret',
        required: false,
        help: 'Auto-generated if left empty',
      },
    ],
    apply: (values) => ({
      telegram: {
        enabled: true,
        bot_token: values.bot_token || undefined,
        bot_username: values.bot_username || undefined,
        secret_token: values.secret_token || undefined,
      },
    }),
  },

  slack: {
    label: 'Slack',
    description:
      'Slack Bot Token (single workspace) or OAuth (multi-workspace)',
    fields: [
      {
        key: 'bot_token',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        required: true,
        help: 'Create at api.slack.com/apps → Bot Token',
      },
      {
        key: 'signing_secret',
        label: 'Signing Secret',
        placeholder: '...',
        required: true,
        help: 'Found in App Credentials',
      },
      {
        key: 'client_id',
        label: 'Client ID (OAuth)',
        placeholder: '...',
        required: false,
        help: 'Only needed for multi-workspace OAuth',
      },
      {
        key: 'client_secret',
        label: 'Client Secret (OAuth)',
        placeholder: '...',
        required: false,
        help: 'Only needed for multi-workspace OAuth',
      },
    ],
    apply: (values) => ({
      slack: {
        enabled: true,
        bot_token: values.bot_token || undefined,
        signing_secret: values.signing_secret || undefined,
        client_id: values.client_id || undefined,
        client_secret: values.client_secret || undefined,
      },
    }),
  },

  gchat: {
    label: 'Google Chat',
    description: 'Google Chat API with service account credentials',
    fields: [
      {
        key: 'project_id',
        label: 'Project ID',
        placeholder: 'my-gcp-project',
        required: true,
        help: 'Google Cloud project ID',
      },
      {
        key: 'credentials_json',
        label: 'Service Account JSON',
        placeholder: '{"type": "service_account", ...}',
        required: true,
        help: 'Paste the full service account JSON key',
      },
    ],
    apply: (values) => ({
      gchat: {
        enabled: true,
        project_id: values.project_id || undefined,
        credentials_json: values.credentials_json || undefined,
      },
    }),
  },

  teams: {
    label: 'Microsoft Teams',
    description: 'Azure Bot Service registration',
    fields: [
      {
        key: 'app_id',
        label: 'App ID',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        required: true,
        help: 'Azure Bot → Application (client) ID',
      },
      {
        key: 'app_password',
        label: 'App Password',
        placeholder: '...',
        required: true,
        help: 'Azure Bot → Client Secrets → New client secret',
      },
    ],
    apply: (values) => ({
      teams: {
        enabled: true,
        app_id: values.app_id || undefined,
        app_password: values.app_password || undefined,
      },
    }),
  },

  discord: {
    label: 'Discord',
    description:
      'Discord Bot Token + Application ID for slash commands and interactions',
    fields: [
      {
        key: 'bot_token',
        label: 'Bot Token',
        placeholder: 'MTE...',
        required: true,
        help: 'Discord Developer Portal → Bot → Reset Token',
      },
      {
        key: 'application_id',
        label: 'Application ID',
        placeholder: '123456789012345678',
        required: false,
        help: 'Discord Developer Portal → General Information → Application ID',
      },
      {
        key: 'public_key',
        label: 'Public Key',
        placeholder: '...',
        required: false,
        help: 'For interaction signature verification (optional)',
      },
    ],
    apply: (values) => ({
      discord: {
        enabled: true,
        bot_token: values.bot_token || undefined,
        application_id: values.application_id || undefined,
        public_key: values.public_key || undefined,
      },
    }),
  },

  feishu: {
    label: 'Feishu / Lark',
    description:
      'Feishu Open Platform app credentials. Supports both feishu.cn and larksuite.com domains.',
    fields: [
      {
        key: 'app_id',
        label: 'App ID',
        placeholder: 'cli_xxxxx',
        required: true,
        help: 'Feishu Open Platform → Credentials & Basic Info',
      },
      {
        key: 'app_secret',
        label: 'App Secret',
        placeholder: '...',
        required: true,
        help: 'Feishu Open Platform → Credentials & Basic Info',
      },
      {
        key: 'encrypt_key',
        label: 'Encrypt Key',
        placeholder: '...',
        required: false,
        help: 'Optional. For event encryption. Feishu Open Platform → Event Encryption',
      },
      {
        key: 'verification_token',
        label: 'Verification Token',
        placeholder: '...',
        required: false,
        help: 'Optional. For event signature verification',
      },
      {
        key: 'domain',
        label: 'Domain',
        placeholder: 'feishu or lark',
        required: false,
        help: 'feishu = feishu.cn (China), lark = larksuite.com (International)',
      },
    ],
    apply: (values) => ({
      feishu: {
        enabled: true,
        app_id: values.app_id || undefined,
        app_secret: values.app_secret || undefined,
        encrypt_key: values.encrypt_key || undefined,
        verification_token: values.verification_token || undefined,
        domain: (values.domain as 'feishu' | 'lark') || undefined,
      },
    }),
  },

  qq: {
    label: 'QQ Official Bot',
    description: 'QQ Official Bot API credentials from q.qq.com',
    fields: [
      {
        key: 'appid',
        label: 'App ID',
        placeholder: '102xxxxxx',
        required: true,
        help: 'QQ Open Platform → App Management → App ID',
      },
      {
        key: 'secret',
        label: 'App Secret',
        placeholder: '...',
        required: true,
        help: 'QQ Open Platform → App Management → App Secret',
      },
      {
        key: 'sandbox',
        label: 'Sandbox Mode',
        placeholder: 'true or false',
        required: false,
        help: 'Enable sandbox environment for testing',
      },
      {
        key: 'intents',
        label: 'Intents',
        placeholder: 'GROUP_AND_C2C_EVENT,GUILD_MESSAGES,...',
        required: false,
        help: 'Comma-separated list of intents to subscribe. Common: GROUP_AND_C2C_EVENT, GUILD_MESSAGES, DIRECT_MESSAGE',
      },
    ],
    apply: (values) => ({
      qq: {
        enabled: true,
        appid: values.appid || undefined,
        secret: values.secret || undefined,
        sandbox: values.sandbox === 'true' || undefined,
        intents: values.intents || undefined,
      },
    }),
  },
};

export const PRESET_LIST = Object.entries(CHANNEL_PRESETS).map(
  ([key, preset]) => ({
    value: key,
    label: preset.label,
    description: preset.description,
  }),
);
