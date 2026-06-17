import type { AdapterName, ChannelsConfig } from '@/types/config/channels';
import { locales, defaultLocale, type Locale, translate, type TranslationKey } from '@/lib/i18n';

const LOCAL_BASE_URL = 'http://127.0.0.1:3000';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function isProductionDeployment(): boolean {
  const vercelEnvironment =
    process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV;

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
  const vercelEnv =
    process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  const branchUrl = process.env.VERCEL_BRANCH_URL?.trim();
  const productionUrl =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL?.trim() ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  const baseUrl = productionUrl ?? branchUrl ?? vercelUrl ?? LOCAL_BASE_URL;
  const result = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  console.log('[getAppBaseUrl]', {
    vercelEnv,
    vercelUrl,
    branchUrl,
    productionUrl,
    result: normalizeBaseUrl(result),
  });

  return normalizeBaseUrl(result);
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
      allowed_updates: '["message","callback_query"]',
    });
    if (secretToken) {
      params.set('secret_token', secretToken);
    }

    const apiUrl = `https://api.telegram.org/bot${token}/setWebhook?${params.toString()}`;
    console.log(
      '[registerTelegramWebhook] calling:',
      apiUrl.replace(token, '***'),
    );

    const resp = await fetch(apiUrl, { method: 'POST' });
    const data = (await resp.json()) as {
      ok: boolean;
      description?: string;
    };

    console.log('[registerTelegramWebhook] response:', data);

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

// Telegram command list — only the commands we register with setMyCommands.
// The displayed description comes from the slash.command.* i18n namespace
// so each user sees their Telegram client's locale (when we registered a
// matching language_code) or the default (English).
const TELEGRAM_REGISTERED_COMMANDS = [
  'help',
  'new',
  'sessions',
  'session',
  'switch',
  'delete_session',
  'status',
  'stop',
  'compact',
  'model',
  'provider',
] as const;

// Map agentboster Locale → Telegram language_code (ISO 639-1).
// Telegram does not distinguish zh-CN / zh-TW / zh-HK — collapse to "zh".
// en-GB is dropped (handled by default + en override).
const LOCALE_TO_LANGUAGE_CODE: Partial<Record<Locale, string>> = {
  'en-US': 'en',
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'zh-HK': 'zh',
  ja: 'ja',
  ko: 'ko',
};

interface TelegramCommand {
  command: string;
  description: string;
}

function buildTelegramCommands(locale: Locale): TelegramCommand[] {
  return TELEGRAM_REGISTERED_COMMANDS.map((command) => {
    const descriptionKey = `slash.command.${command}.description` as TranslationKey;
    return {
      command,
      description: translate(locale, descriptionKey),
    };
  });
}

async function callSetMyCommands(
  token: string,
  commands: TelegramCommand[],
  languageCode?: string,
): Promise<void> {
  const apiUrl = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body: Record<string, unknown> = { commands };
  if (languageCode) {
    body.language_code = languageCode;
  }
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    console.warn(
      `[registerTelegramCommands] failed${languageCode ? ` (${languageCode})` : ' (default)'}:`,
      data.description,
    );
  }
}

/**
 * Register Telegram bot commands in every supported locale.
 *
 * Telegram's setMyCommands API accepts an optional language_code — when
 * a user's Telegram client is set to that language, Telegram serves the
 * matching command list. Without language_code, the registration becomes
 * the default shown to users whose client language has no specific match.
 *
 * We register:
 *   - default (no language_code) → English (international fallback)
 *   - en, zh, ja, ko → matching language_code
 *
 * Per-language failures are isolated — a single language failing to
 * register does not abort the rest. This keeps the function idempotent
 * and safe to call from webhook registration and connection-test paths.
 */
export async function registerTelegramCommands(token: string): Promise<void> {
  try {
    // Default: English (covers users whose Telegram language we don't
    // have a specific match for — e.g. Russian, Spanish).
    await callSetMyCommands(token, buildTelegramCommands(defaultLocale));

    // Per-language registrations. Collapse duplicates (e.g. zh-CN/zh-TW
    // both map to "zh"); the last write wins on Telegram's side.
    const registered = new Set<string>();
    for (const locale of locales) {
      const code = LOCALE_TO_LANGUAGE_CODE[locale];
      if (!code || registered.has(code)) continue;
      registered.add(code);
      // Pick the first locale that maps to this code as the translation source.
      const sourceLocale = locale;
      try {
        await callSetMyCommands(
          token,
          buildTelegramCommands(sourceLocale),
          code,
        );
      } catch (error) {
        console.warn(
          `[registerTelegramCommands] error (${code}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } catch (error) {
    console.warn(
      '[registerTelegramCommands] error:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function registerChannelWebhooks(
  channels: ChannelsConfig | undefined,
): Promise<WebhookRegistrationResult[]> {
  if (!channels) return [];

  const results: WebhookRegistrationResult[] = [];
  const secret = getBotAuthSecret();
  const baseUrl = getAppBaseUrl();

  if (channels.telegram?.enabled && channels.telegram.bot_token) {
    if (!secret) {
      results.push({
        adapter: 'telegram',
        ok: false,
        error:
          'AUTH_SECRET is not configured. Set AUTH_SECRET env var to enable webhook registration.',
      });
    } else {
      const webhookUrl = `${baseUrl}/api/bot/${secret}/telegram/callback`;
      console.log('[registerChannelWebhooks] telegram webhookUrl:', webhookUrl);
      const result = await registerTelegramWebhook(
        channels.telegram.bot_token,
        webhookUrl,
        channels.telegram.secret_token || undefined,
      );
      results.push(result);
      if (result.ok) {
        await registerTelegramCommands(channels.telegram.bot_token);
      }
    }
  }

  return results;
}
