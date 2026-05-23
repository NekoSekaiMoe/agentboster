import type { ApiKey } from './types';

const KEY_PREFIX = 'ac_';
const KEY_LENGTH = 32;

function generateRandomKey(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const key = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  return `${KEY_PREFIX}${key}`;
}

export function createApiKey(
  name: string,
  scopes: string[],
  expiresAt?: number,
): ApiKey {
  return {
    key: generateRandomKey(),
    name,
    scopes,
    expiresAt,
  };
}

export function isApiKeyExpired(apiKey: ApiKey): boolean {
  if (!apiKey.expiresAt) return false;
  return apiKey.expiresAt < Math.floor(Date.now() / 1000);
}

export function isApiKeyValid(apiKey: ApiKey): boolean {
  return apiKey.key.startsWith(KEY_PREFIX) && !isApiKeyExpired(apiKey);
}
