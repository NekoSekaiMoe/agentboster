/**
 * config — persist advisor settings inside ~/.agentboster/config.json.
 *
 * The advisor extension is a client-side one-shot: it calls a provider API
 * directly rather than routing through the web backend (which only forwards
 * the latest user turn and owns model choice server-side). Because of that it
 * needs its own persisted model choice, effort level, and API key material.
 *
 * Settings live under the `advisor` key of the shared config file so all CLI
 * state stays in one place.
 */

import {
  type AdvisorStoredConfig,
  readStoredConfig,
  writeStoredConfig,
} from '@agentboster/adapter';

export type AdvisorApi = 'anthropic-messages' | 'openai-completions';

export type AdvisorConfig = AdvisorStoredConfig;

export function loadAdvisorConfig(): AdvisorConfig {
  const stored = readStoredConfig();
  return stored?.advisor ?? {};
}

export function saveAdvisorConfig(config: AdvisorConfig): boolean {
  try {
    const stored = readStoredConfig();
    if (!stored) return false;
    writeStoredConfig({ ...stored, advisor: config });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an api-key spec to the actual secret.
 *
 * "$ENV_VAR" or "${ENV_VAR}" reads from the environment; anything else is
 * returned verbatim. Returns undefined when the resolved value is empty.
 */
export function resolveApiKey(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  const match = trimmed.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (match) {
    const value = process.env[match[1]];
    return value && value.length > 0 ? value : undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Default base URL for a given api protocol. */
export function defaultBaseUrl(api: AdvisorApi): string {
  return api === 'anthropic-messages'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com';
}
