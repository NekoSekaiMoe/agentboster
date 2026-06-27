import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * On-disk CLI configuration. Stored as JSON at ~/.agentboster/cli.json.
 *
 * Fields:
 * - clientId: stable per-machine identifier. Used as the session channel
 *   suffix ('cli:<clientId>') so two CLI processes on the same host can
 *   share sessions, but a CLI on a different host cannot. Generated on
 *   first run from a random UUID.
 * - deployments: named web deployments the user has authenticated
 *   against. Each entry holds the baseUrl + auth token + expiry.
 *   `default` is the active deployment unless overridden by --deployment.
 */
export type CliDeployment = {
  baseUrl: string;
  /** Bearer token returned by POST /api/auth/login. */
  token: string;
  /** Token expiry, epoch ms. */
  expiresAt: number;
  /** Cached userId from the login response. */
  userId: string;
  /** Cached username from the login response. */
  username: string;
};

export type CliConfig = {
  clientId: string;
  /** Human-readable label sent to the server for logging/UI. */
  label: string;
  deployments: Record<string, CliDeployment>;
  /** Which deployment name to use by default. */
  defaultDeployment?: string;
};

const CONFIG_DIR = join(homedir(), '.agentboster');
const CONFIG_PATH = join(CONFIG_DIR, 'cli.json');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): CliConfig | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as CliConfig;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.clientId !== 'string' ||
      typeof parsed.label !== 'string' ||
      typeof parsed.deployments !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Load existing config or initialize a fresh one with a new clientId.
 * The clientId persists across runs so sessions started today can be
 * continued tomorrow from the same machine.
 */
export function ensureConfig(): CliConfig {
  const existing = loadConfig();
  if (existing) {
    return existing;
  }

  const fresh: CliConfig = {
    clientId: randomUUID(),
    label: hostname() || 'cli-host',
    deployments: {},
  };
  saveConfig(fresh);
  return fresh;
}

export function getActiveDeployment(
  config: CliConfig,
  name?: string,
): { name: string; deployment: CliDeployment } | null {
  const target = name ?? config.defaultDeployment;
  if (!target) {
    const entries = Object.entries(config.deployments);
    if (entries.length === 0) {
      return null;
    }
    const [fallbackName, deployment] = entries[0];
    return { name: fallbackName, deployment };
  }
  const deployment = config.deployments[target];
  if (!deployment) {
    return null;
  }
  return { name: target, deployment };
}
