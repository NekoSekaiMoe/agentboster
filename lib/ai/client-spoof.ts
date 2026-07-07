import type { AppConfig } from '@/types/config';
import type { ClientSpoof } from '@/types/config/ai';

/**
 * The OpenAI API mode an endpoint resolves to. `codex` spoof only makes
 * sense against the Responses API (/v1/responses); never apply to Legacy.
 */
export type OpenAIApiMode = 'chat' | 'responses' | undefined;

const CLIENT_SPOOF_VALUES = new Set<ClientSpoof>(['off', 'on']);

/**
 * Per-format spoof profile. When spoof is enabled ("on"), the spoof headers
 * are auto-selected from this map based on the provider format.
 */
const FORMAT_SPOOF_MAP: Record<
  string,
  { headers: Record<string, string>; openaiResponsesOnly?: true } | undefined
> = {
  anthropic: { headers: { 'User-Agent': 'claude-code/1.0' } },
  openai: {
    headers: { 'User-Agent': 'codex-cli/1.0' },
    openaiResponsesOnly: true,
  },
  google: { headers: { 'User-Agent': 'antigravity-cli/1.0' } },
};

export function normalizeClientSpoof(value: unknown): ClientSpoof {
  return CLIENT_SPOOF_VALUES.has(value as ClientSpoof)
    ? (value as ClientSpoof)
    : 'off';
}

/**
 * Whether the provider format has a spoof profile to apply.
 */
export function isClientSpoofSupported(format: string | undefined): boolean {
  return format !== undefined && format in FORMAT_SPOOF_MAP;
}

/**
 * Resolve the spoof state after applying format + openai-api guard.
 * Returns 'off'|'on'.
 */
export function getEffectiveProviderClientSpoof(
  format: string | undefined,
  clientSpoof: unknown,
  openaiApi?: OpenAIApiMode,
): ClientSpoof {
  const normalized = normalizeClientSpoof(clientSpoof);
  if (normalized !== 'on') return 'off';
  if (!format) return 'off';
  const profile = FORMAT_SPOOF_MAP[format];
  if (!profile) return 'off';
  if (profile.openaiResponsesOnly && openaiApi === 'chat') return 'off';
  return 'on';
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
    if (!overrideKeys.has(key.toLowerCase())) next[key] = value;
  }
  return { ...next, ...overrides };
}

/**
 * Apply format-matched spoof headers to the request's header bag.
 * Returns the original `headers` when spoof is off or no format matches.
 */
export function applyClientSpoofHeaders(
  format: string | undefined,
  headers: Record<string, string> | undefined,
  clientSpoof: unknown,
  openaiApi?: OpenAIApiMode,
): Record<string, string> | undefined {
  if (clientSpoof !== 'on') return headers;
  if (!format) return headers;
  const profile = FORMAT_SPOOF_MAP[format];
  if (!profile) return headers;
  if (profile.openaiResponsesOnly && openaiApi === 'chat') return headers;
  return withHeaderOverrides(headers, profile.headers);
}

/**
 * Override all providers with the global client_spoof value from CLI/Desktop.
 * When "on", each provider gets its format-appropriate spoof at request time.
 */
export function applyClientSpoofOverride(
  config: AppConfig,
  clientSpoof: unknown,
): AppConfig {
  if (clientSpoof === undefined) return config;
  const normalized = clientSpoof === 'on' ? 'on' : 'off';

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
      client_spoof: 'on',
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
