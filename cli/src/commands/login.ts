import { input, password } from '@inquirer/prompts';
import { performLogin } from '../lib/login-core';

/**
 * `agentboster login --url ... [--username ...] [--password ...]`
 *
 * Interactive prompts for any missing required field, then calls
 * performLogin. Prints the result and exits with status 0/1.
 */
export async function loginCommand(options: {
  baseUrl: string;
  username?: string;
  password?: string;
  name?: string;
}): Promise<void> {
  if (!options.baseUrl) {
    console.error('Error: --url is required (your agentboster web URL)');
    process.exit(1);
  }

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

  const result = await performLogin({
    baseUrl: options.baseUrl,
    username,
    password: userPassword,
    name: options.name,
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const expiryDate = new Date(result.deployment.expiresAt).toLocaleString();
  console.log(
    `Logged in as ${result.deployment.username} (${result.deployment.userId}) on ${result.deployment.baseUrl}`,
  );
  console.log(`Token expires: ${expiryDate}`);
  console.log(`Deployment saved as "${result.deploymentName}".`);
}
