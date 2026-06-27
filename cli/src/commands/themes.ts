import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureConfig, saveConfig } from '../lib/config';
import { loadUserTheme } from '../tui/theme';

const THEMES_DIR = join(homedir(), '.agentboster', 'themes');
const DEFAULT_THEME_NAME = 'default';

/**
 * `agentboster themes [name]`
 *
 * Without args: lists installed themes (built-in default + any custom
 * files under ~/.agentboster/themes/*.json).
 *
 * With a name: sets it as the active theme (validated by loading) and
 * persists to config. The next TUI invocation picks it up.
 */
export async function themesCommand(options: { set?: string }): Promise<void> {
  if (options.set) {
    return setTheme(options.set);
  }

  const customs = listCustomThemes();
  const star = '\u2713';
  console.log('Available themes:');
  console.log();
  console.log(
    `  ${star} ${DEFAULT_THEME_NAME} (built-in dark; light available as 'light')`,
  );
  for (const name of customs) {
    console.log(`    ${name}  (~/.agentboster/themes/${name}.json)`);
  }
  if (customs.length === 0) {
    console.log();
    console.log(
      'No custom themes installed. Drop a JSON file at ~/.agentboster/themes/<name>.json',
    );
    console.log(
      'Schema: { "kind": "dark" | "light", "overrides": { "primary": "#hex", ... } }',
    );
  }
}

function listCustomThemes(): string[] {
  if (!existsSync(THEMES_DIR)) return [];
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

async function setTheme(name: string): Promise<void> {
  // Validate by loading. Falls back with a stderr warning if missing.
  loadUserTheme(name);
  const config = ensureConfig();
  config.theme = name;
  saveConfig(config);
  console.log(`Active theme set to '${name}'.`);
}
