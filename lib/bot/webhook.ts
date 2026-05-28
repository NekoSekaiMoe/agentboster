import type { AdapterName, ChannelsConfig } from '@/types/config/channels';

const LOCAL_BASE_URL = 'http://127.0.0.1:3000';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function isProductionDeployment(): boolean {
  const vercelEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV;

  if (vercelEnvironment) {
    return vercelEnvironment === 'production';
  }

  return process.env.NODE_ENV === 'production';
}

export function getBotAuthSecret(): string | null {
  const secret = process.env.AUTH_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

export function assertBotAuthSecret(): string {
  const secret = getBotAuthSecret();
  if (!secret) {
    throw new Error('AUTH_SECRET is required for bot callbacks.');
  }

  return secret;
}

export function isValidBotSecret(secret: string): boolean {
  const expected = getBotAuthSecret();
  if (!expected) return false;
  if (secret.length !== expected.length) return false;

  let result = 0;
  for (let index = 0; index < secret.length; index += 1) {
    result |= secret.charCodeAt(index) ^ expected.charCodeAt(index);
  }

  return result === 0;
}

export function getAppBaseUrl(): string {
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;

  // Production deployment — use production URL
  if (vercelEnv === 'production') {
    const vercelUrl =
      process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL?.trim();
    if (vercelUrl) {
      return normalizeBaseUrl(`https://${vercelUrl}`);
    }
  }

  // Preview deployment — use branch deployment URL
  if (vercelEnv === 'preview') {
    const branchUrl = process.env.VERCEL_BRANCH_URL?.trim();
    if (branchUrl) {
      return normalizeBaseUrl(`https://${branchUrl}`);
    }
    // Fallback: current deployment URL
    const deploymentUrl = process.env.VERCEL_URL?.trim();
    if (deploymentUrl) {
      return normalizeBaseUrl(`https://${deploymentUrl}`);
    }
  }

  // Development or unrecognized environment
  if (vercelEnv) {
    // Running on Vercel but not production/preview (e.g. development on Vercel)
    const deploymentUrl = process.env.VERCEL_URL?.trim();
    if (deploymentUrl) {
      return normalizeBaseUrl(`https://${deploymentUrl}`);
    }
  }

  return LOCAL_BASE_URL;
}

export function getWebhookCallbackPath(
  adapter: AdapterName,
  authSecret = assertBotAuthSecret(),
): string {
  return `/api/bot/${authSecret}/${adapter}/callback`;
}

export function getWebhookCallbackUrl(adapter: AdapterName): string | null {
  const secret = getBotAuthSecret();
  if (!secret) {
    return null;
  }

  // Feishu and QQ use the same unified callback path
  return `${getAppBaseUrl()}${getWebhookCallbackPath(adapter, secret)}`;
}

export function getWebhookCallbackUrls(
  adapters: AdapterName[],
): Record<AdapterName, string | null> {
  const secret = getBotAuthSecret();
  const baseUrl = getAppBaseUrl();
  const result = {} as Record<AdapterName, string | null>;
  for (const adapter of adapters) {
    result[adapter] = secret
      ? `${baseUrl}/api/bot/${secret}/${adapter}/callback`
      : null;
  }
  return result;
}

export type WebhookRegistrationResult = {
  adapter: AdapterName;
  ok: boolean;
  detail?: string;
  error?: string;
};

export async function registerTelegramWebhook(
  token: string,
  webhookUrl: string,
  secretToken?: string,
): Promise<WebhookRegistrationResult> {
  try {
    const parsed = new URL(webhookUrl);
    if (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.protocol === 'http:'
    ) {
      return {
        adapter: 'telegram',
        ok: false,
        error: `Webhook URL must be a public HTTPS URL. Got: ${webhookUrl}. Set NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL or deploy to production first.`,
      };
    }

    const params = new URLSearchParams({
      url: webhookUrl,
      drop_pending_updates: 'true',
    });
    if (secretToken) {
      params.set('secret_token', secretToken);
    }

    const resp = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook?${params.toString()}`,
      { method: 'POST' },
    );
    const data = (await resp.json()) as {
      ok: boolean;
      description?: string;
    };

    if (data.ok) {
      return {
        adapter: 'telegram',
        ok: true,
        detail: `Webhook registered: ${webhookUrl}`,
      };
    }

    return {
      adapter: 'telegram',
      ok: false,
      error: data.description || 'Telegram setWebhook failed',
    };
  } catch (error) {
    return {
      adapter: 'telegram',
      ok: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function registerChannelWebhooks(
  channels: ChannelsConfig | undefined,
): Promise<WebhookRegistrationResult[]> {
  if (!channels) return [];

  const results: WebhookRegistrationResult[] = [];
  const secret = getBotAuthSecret();
  if (!secret) return [];

  const baseUrl = getAppBaseUrl();

  if (channels.telegram?.enabled && channels.telegram.bot_token) {
    const webhookUrl = `${baseUrl}/api/bot/${secret}/telegram/callback`;
    const result = await registerTelegramWebhook(
      channels.telegram.bot_token,
      webhookUrl,
      channels.telegram.secret_token || undefined,
    );
    results.push(result);
  }

  return results;
}
