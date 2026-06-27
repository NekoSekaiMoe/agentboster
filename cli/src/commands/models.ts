import chalk from 'chalk';
import { ensureConfig, getActiveDeployment, loadConfig } from '../lib/config';
import { createApiClient, type ListModelsResponse } from '../lib/api';

/**
 * `agentboster models`
 *
 * Lists the model catalog configured on the web deployment. The first
 * column marks the default with a star; the rest is id + context
 * window. Output format mirrors what the TUI model picker will show.
 */
export async function modelsCommand(options: {
  deployment?: string;
}): Promise<void> {
  const loaded = loadConfig();
  if (!loaded) {
    console.error(
      'Not logged in. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const config = ensureConfig();
  const active = getActiveDeployment(config, options.deployment);
  if (!active) {
    console.error(
      'No configured deployment. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const client = createApiClient(active.deployment);

  let response: ListModelsResponse;
  try {
    response = await client<ListModelsResponse>('/api/cli/models');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list models: ${msg}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Server error: ${JSON.stringify(response).slice(0, 200)}`);
    process.exit(1);
  }

  if (response.models.length === 0) {
    console.log(
      chalk.gray(
        `Model catalog is empty on ${active.deployment.baseUrl}. The server accepts any model id; pick one with --model <provider/name> at chat time.`,
      ),
    );
    if (response.defaultModel) {
      console.log(`Default: ${chalk.cyan(response.defaultModel)}`);
    }
    return;
  }

  console.log(chalk.bold('Available models:'));
  console.log();

  for (const model of response.models) {
    const isDefault = model.id === response.defaultModel;
    const star = isDefault ? chalk.green('*') : ' ';
    const ctx = model.contextLimit
      ? chalk.gray(`  ctx ${formatNumber(model.contextLimit)}`)
      : '';
    const max = model.maxOutputTokens
      ? chalk.gray(`  out ${formatNumber(model.maxOutputTokens)}`)
      : '';
    console.log(`  ${star} ${chalk.cyan(model.id)}${ctx}${max}`);
  }

  console.log();
  console.log(
    chalk.gray(
      `${chalk.green('*')} = server default. Override at chat time with --model <id>.`,
    ),
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
