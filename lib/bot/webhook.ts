import type { AdapterName } from '@/types/config/channels';

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
  if (!isProductionDeployment()) {
    return LOCAL_BASE_URL;
  }

  const vercelUrl =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelUrl) {
    return normalizeBaseUrl(`https://${vercelUrl}`);
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
