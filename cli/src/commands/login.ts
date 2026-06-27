import { CLI_CONFIG_FILE, type CliConfig } from '../lib/config';
import { writeJson } from '../lib/store';
import { createApiClient } from '../lib/api';

export async function loginCommand(opts: {
  url: string;
  username?: string;
  password?: string;
}): Promise<void> {
  const url = opts.url.trim();
  const username = (
    opts.username ??
    process.env.AGENTBOSTER_USERNAME ??
    ''
  ).trim();
  const passwordValue = (
    opts.password ??
    process.env.AGENTBOSTER_PASSWORD ??
    ''
  ).trim();

  if (!username || !passwordValue) {
    throw new Error('username/password are required for now');
  }

  const api = createApiClient(url);
  const payload = await api.login(username, passwordValue);

  if (!payload.ok || !payload.token) {
    throw new Error(payload.error ?? 'Login failed');
  }

  const config: CliConfig = { url, token: payload.token };
  writeJson(CLI_CONFIG_FILE, config);
  console.log(`Logged in as ${payload.user?.username ?? username}`);
}
