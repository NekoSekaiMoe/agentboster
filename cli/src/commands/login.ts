import { input, password } from '@inquirer/prompts';
import { ensureConfig, saveConfig, type CliDeployment } from '../lib/config';
import { createAnonymousApiClient, type LoginResponse } from '../lib/api';

const DEFAULT_NAME = 'default';

export async function loginCommand(options: {
  baseUrl: string;
  username?: string;
  password?: string;
  name?: string;
}): Promise<void> {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Error: --url is required (your agentboster web URL)');
    process.exit(1);
  }

  const deploymentName = options.name ?? DEFAULT_NAME;

  const username =
    options.username ?? (await input({ message: 'Username:' }).catch(() => ''));
  if (!username) {
    console.error('Error: username is required.');
    process.exit(1);
  }

  const userPassword =
    options.password ??
    (await password({ message: 'Password:', mask: true }).catch(() => ''));
  if (!userPassword) {
    console.error('Error: password is required.');
    process.exit(1);
  }

  const client = createAnonymousApiClient(baseUrl);

  let response: LoginResponse;
  try {
    response = await client<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { username, password: userPassword },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'request failed';
    console.error(`Login request failed: ${message}`);
    process.exit(1);
  }

  if (!response.ok || !response.token || !response.expiresAt || !response.user) {
    console.error(
      `Login failed: ${response.error ?? 'server returned no token'}`,
    );
    process.exit(1);
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
  config.defaultDeployment =
    config.defaultDeployment ?? deploymentName;
  saveConfig(config);

  const expiryDate = new Date(deployment.expiresAt).toLocaleString();
  console.log(
    `Logged in as ${deployment.username} (${deployment.userId}) on ${baseUrl}`,
  );
  console.log(`Token expires: ${expiryDate}`);
  console.log(`Deployment saved as "${deploymentName}".`);
}
