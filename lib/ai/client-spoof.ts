import type { AppConfig } from '@/types/config';
import type { AIProvider, ClientSpoof } from '@/types/config/ai';

const CLIENT_SPOOF_VALUES = new Set<ClientSpoof>([
  'off',
  'claude-code',
  'codex',
  'antigravity',
]);

const CLIENT_SPOOF_HEADERS: Record<
  Exclude<ClientSpoof, 'off'>,
  Record<string, string>
> = {
  'claude-code': {
    'User-Agent': 'claude-code/1.0',
  },
  codex: {
    'User-Agent': 'codex-cli/1.0',
  },
  antigravity: {
    'User-Agent': 'antigravity-cli/1.0',
  },
};

/**
 * The OpenAI API mode an endpoint resolves to. `codex` spoof only makes
 * sense against the Responses API (/v1/responses); it must never be applied
 * to OpenAI Legacy (Chat Completions, /v1/chat/completions).
 */
export type OpenAIApiMode = 'chat' | 'responses' | undefined;

export function normalizeClientSpoof(value: unknown): ClientSpoof {
  return typeof value === 'string' &&
    CLIENT_SPOOF_VALUES.has(value as ClientSpoof)
    ? (value as ClientSpoof)
    : 'off';
}

/**
 * Map each client-spoof profile to the provider format it is valid for.
 * This is the "port" binding: the spoof is recognized from the provider
 * format, not from a free user choice that can leak across ports.
 */
export function isClientSpoofSupported(
  format: AIProvider | string | undefined,
  clientSpoof: ClientSpoof,
): boolean {
  switch (clientSpoof) {
    case 'off':
      return true;
    case 'claude-code':
      return format === 'anthropic';
    case 'codex':
      return format === 'openai';
    case 'antigravity':
      return format === 'google';
    default:
      return false;
  }
}

export function getEffectiveProviderClientSpoof(
  format: AIProvider | string | undefined,
  clientSpoof: unknown,
  openaiApi?: OpenAIApiMode,
): ClientSpoof {
  const normalized = normalizeClientSpoof(clientSpoof);
  if (!isClientSpoofSupported(format, normalized)) return 'off';
  // OpenAI Legacy (Chat Completions) cannot be spoofed as Codex, which is a
  // Responses-API client. Drop the spoof so legacy endpoints stay honest.
  if (normalized === 'codex' && openaiApi === 'chat') return 'off';
  return normalized;
}

function withHeaderOverrides(
  headers: Record<string, string> | undefined,
  overrides: Record<string, string>,
): Record<string, string> {
  const overrideKeys = new Set(
    Object.keys(overrides).map((key) => key.toLowerCase()),
  );
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!overrideKeys.has(key.toLowerCase())) {
      next[key] = value;
    }
  }

  return { ...next, ...overrides };
}

export function applyClientSpoofHeaders(
  format: AIProvider | string | undefined,
  headers: Record<string, string> | undefined,
  clientSpoof: unknown,
  openaiApi?: OpenAIApiMode,
): Record<string, string> | undefined {
  const effective = getEffectiveProviderClientSpoof(
    format,
    clientSpoof,
    openaiApi,
  );
  if (effective === 'off') return headers;
  return withHeaderOverrides(headers, CLIENT_SPOOF_HEADERS[effective]);
}

export function applyClientSpoofOverride(
  config: AppConfig,
  clientSpoof: unknown,
): AppConfig {
  const normalized = normalizeClientSpoof(clientSpoof);
  if (clientSpoof === undefined) return config;

  const models = config.models;
  const providers = models?.providers;
  if (!models || !providers) return config;

  type ProviderMap = NonNullable<NonNullable<AppConfig['models']>['providers']>;
  const nextProviders: ProviderMap = {};
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (normalized === 'off') {
      const nextProvider = { ...providerConfig };
      delete nextProvider.client_spoof;
      nextProviders[providerName] = nextProvider;
      continue;
    }

    nextProviders[providerName] = {
      ...providerConfig,
      client_spoof: normalized,
    };
  }

  return {
    ...config,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}
