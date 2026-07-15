/**
 * Auth storage for the Agentboster adapter.
 *
 * Stores `{ url, token, username }` at `$AGENTBOSTER_HOME/config.json`
 * (default `~/.config/agentboster-cli`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AgentbosterAuth {
  url: string;
  token: string;
  username?: string;
}

export interface AdvisorStoredConfig {
  provider?: string;
  modelId?: string;
  api?: 'anthropic-messages' | 'openai-completions';
  baseUrl?: string;
  effort?: string;
  apiKey?: string;
}

export interface AgentbosterStoredConfig {
  url: string;
  token?: string;
  username?: string;
  advisor?: AdvisorStoredConfig;
}

export function getAgentbosterHome(): string {
  if (process.env.AGENTBOSTER_HOME) return process.env.AGENTBOSTER_HOME;
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'agentboster-cli');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agentboster-cli');
    default:
      return join(home, '.config', 'agentboster-cli');
  }
}

export function getConfigPath(): string {
  return join(getAgentbosterHome(), 'config.json');
}

export function readStoredConfig(): AgentbosterStoredConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentbosterStoredConfig;
  } catch {
    return null;
  }
}

export function writeStoredConfig(config: AgentbosterStoredConfig): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function getStoredAuth(): AgentbosterAuth | null {
  const stored = readStoredConfig();
  if (!stored?.url || !stored?.token) return null;
  return { url: stored.url, token: stored.token, username: stored.username };
}

export function clearStoredAuth(): void {
  const stored = readStoredConfig();
  if (!stored) return;
  writeStoredConfig({ url: stored.url });
}
