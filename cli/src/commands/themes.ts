import chalk from 'chalk';
import { DEFAULT_THEME_NAME, listCustomThemes, loadTheme } from '../lib/theme';

/**
 * `agentboster themes [name]`
 *
 * Without args: lists installed themes (built-in default + any custom
 * files under ~/.agentboster/themes/*.json).
 *
 * With a name argument: sets that theme as the active one by writing
 * it to ~/.agentboster/cli.json. The next TUI invocation picks it up.
 */
export async function themesCommand(options: { set?: string }): Promise<void> {
  if (options.set) {
    return setTheme(options.set);
  }

  const customs = listCustomThemes();
  console.log(chalk.bold('Available themes:'));
  console.log();
  console.log(
    `  ${chalk.green('*')} ${chalk.cyan(DEFAULT_THEME_NAME)} ${chalk.gray('(built-in)')}`,
  );
  for (const name of customs) {
    console.log(
      `    ${chalk.cyan(name)} ${chalk.gray(`(~/.agentboster/themes/${name}.json)`)}`,
    );
  }
  if (customs.length === 0) {
    console.log();
    console.log(
      chalk.gray(
        'No custom themes installed. Drop a JSON file at ~/.agentboster/themes/<name>.json — see the README for the schema.',
      ),
    );
  }
}

async function setTheme(name: string): Promise<void> {
  // Validate by trying to load it. Defaults to built-in if missing.
  loadTheme(name);

  const { ensureConfig, saveConfig } = await import('../lib/config');
  const config = ensureConfig();
  config.theme = name;
  saveConfig(config);
  console.log(chalk.green(`Active theme set to '${name}'.`));
}
