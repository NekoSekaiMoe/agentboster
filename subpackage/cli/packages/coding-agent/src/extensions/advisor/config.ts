/**
 * config — persist advisor settings to ~/.agentboster/advisor.json.
 *
 * The advisor extension is a client-side one-shot: it calls a provider API
 * directly rather than routing through the web backend (which only forwards
 * the latest user turn and owns model choice server-side). Because of that it
 * needs its own persisted model choice, effort level, and API key material.
 *
 * All node:* imports are dynamic — this file is not part of the workflow
 * bundle, but the codebase convention is to keep node built-ins out of
 * top-level imports so files stay safe to move.
 */

import { getAgentDir } from '../../config.ts';

export type AdvisorApi = 'anthropic-messages' | 'openai-completions';

export interface AdvisorConfig {
  /** Provider id, e.g. "anthropic" or "openai". Display/label only. */
  provider?: string;
  /** Concrete model id sent to the provider, e.g. "claude-opus-4-20250514". */
  modelId?: string;
  /** Which wire protocol to use when calling the provider. */
  api?: AdvisorApi;
  /** Base URL override. Defaults per-api when omitted. */
  baseUrl?: string;
  /** Thinking/effort level, or undefined for none. */
  effort?: string;
  /**
   * API key. Supports "$ENV_VAR" interpolation so users can avoid writing the
   * secret to disk. A bare string is used verbatim.
   */
  apiKey?: string;
}

const CONFIG_FILENAME = 'advisor.json';

async function configPath(): Promise<string> {
  const { join } = await import('node:path');
  return join(getAgentDir(), CONFIG_FILENAME);
}

export async function loadAdvisorConfig(): Promise<AdvisorConfig> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(await configPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as AdvisorConfig;
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveAdvisorConfig(
  config: AdvisorConfig,
): Promise<boolean> {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const target = await configPath();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
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
