import {
  ensureConfig,
  saveConfig,
  type CliConfig,
  type CliDeployment,
} from './config';
import { createAnonymousApiClient, type LoginResponse } from './api';

const DEFAULT_NAME = 'default';

/**
 * Result type for performLogin. Never throws — callers branch on
 * `ok` and surface the error string however fits their context
 * (stderr+exit for the CLI subcommand, status line for the TUI).
 */
export type LoginResult =
  | {
      ok: true;
      deployment: CliDeployment;
      deploymentName: string;
      config: CliConfig;
    }
  | { ok: false; error: string };

/**
 * Core login routine — calls POST /api/auth/login, persists the
 * returned token into ~/.agentboster/cli.json under the given
 * deployment name, and returns the updated config. No process.exit,
 * no console output; purely functional. Both the `agentboster login`
 * subcommand and the TUI's inline login path call this.
 */
export async function performLogin(input: {
  baseUrl: string;
  username: string;
  password: string;
  name?: string;
}): Promise<LoginResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, '');
  if (!baseUrl) {
    return { ok: false, error: 'URL is required.' };
  }
  if (!input.username) {
    return { ok: false, error: 'Username is required.' };
  }
  if (!input.password) {
    return { ok: false, error: 'Password is required.' };
  }

  const deploymentName = input.name ?? DEFAULT_NAME;
  const client = createAnonymousApiClient(baseUrl);

  let response: LoginResponse;
  try {
    response = await client<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { username: input.username, password: input.password },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed';
    return { ok: false, error: `Login request failed: ${message}` };
  }

  if (
    !response.ok ||
    !response.token ||
    !response.expiresAt ||
    !response.user
  ) {
    return {
      ok: false,
      error: `Login failed: ${response.error ?? 'server returned no token'}`,
    };
  }

  const deployment: CliDeployment = {
    baseUrl,
    token: response.token,
    expiresAt: response.expiresAt,
    userId: response.user.id,
    username: response.user.username,
  };

  const config = ensureConfig();
  config.deployments[deploymentName] = deployment;
  config.defaultDeployment = config.defaultDeployment ?? deploymentName;
  saveConfig(config);

  return { ok: true, deployment, deploymentName, config };
}
