import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';

/**
 * Theme shape. All fields optional — missing fields fall back to the
 * built-in default theme. Each field is a chalk style name or a hex
 * color (#rrggbb) for direct color, mirroring how chalk chains compose.
 *
 * Stored as JSON at ~/.agentboster/themes/<name>.json. The active
 * theme name lives in the config file (~/.agentboster/cli.json) under
 * the `theme` field; defaults to 'default' (built-in).
 */
export type CliTheme = {
  name?: string;
  // Chat prefixes
  userPrefix?: string;
  assistantPrefix?: string;
  // Editor border
  border?: string;
  // Status line
  status?: string;
  statusStreaming?: string;
  statusError?: string;
  // Markdown
  heading?: string;
  code?: string;
  link?: string;
  bold?: string;
  italic?: string;
  // Picker selection
  selectedPrefix?: string;
};

const THEMES_DIR = join(homedir(), '.agentboster', 'themes');
const DEFAULT_THEME_NAME = 'default';

const BUILTIN_DEFAULT: Required<CliTheme> = {
  name: 'default',
  userPrefix: 'cyan',
  assistantPrefix: 'magenta',
  border: 'cyan',
  status: 'gray',
  statusStreaming: 'cyan',
  statusError: 'red',
  heading: 'bold',
  code: 'yellow',
  link: 'blue',
  bold: 'bold',
  italic: 'italic',
  selectedPrefix: 'cyan',
};

/**
 * Look up a chalk function by name. Accepts either a chalk style name
 * ('cyan', 'bold', 'redBright') or a hex color (#rrggbb) for direct
 * coloring. Returns the identity function (no styling) if not found,
 * so a malformed theme file never crashes the TUI.
 */
function resolveStyle(spec: string): (s: string) => string {
  if (spec.startsWith('#')) {
    return (s: string) => chalk.hex(spec)(s);
  }
  // chalk supports chained styles like 'bold.cyan'; build the chain.
  const chain = spec.split('.').reduce<(s: string) => string>(
    (acc, name) => {
      const next = (acc as unknown as Record<string, (s: string) => string>)[
        name
      ];
      return typeof next === 'function' ? next.bind(acc) : acc;
    },
    chalk as unknown as (s: string) => string,
  );
  return typeof chain === 'function' ? chain : (s: string) => s;
}

export type ResolvedTheme = {
  userPrefix: (s: string) => string;
  assistantPrefix: (s: string) => string;
  border: (s: string) => string;
  status: (s: string) => string;
  statusStreaming: (s: string) => string;
  statusError: (s: string) => string;
  heading: (s: string) => string;
  code: (s: string) => string;
  link: (s: string) => string;
  bold: (s: string) => string;
  italic: (s: string) => string;
  selectedPrefix: (s: string) => string;
};

export function resolveTheme(theme: CliTheme): ResolvedTheme {
  const merged: Required<CliTheme> = { ...BUILTIN_DEFAULT, ...theme };
  return {
    userPrefix: resolveStyle(merged.userPrefix),
    assistantPrefix: resolveStyle(merged.assistantPrefix),
    border: resolveStyle(merged.border),
    status: resolveStyle(merged.status),
    statusStreaming: resolveStyle(merged.statusStreaming),
    statusError: resolveStyle(merged.statusError),
    heading: resolveStyle(merged.heading),
    code: resolveStyle(merged.code),
    link: resolveStyle(merged.link),
    bold: resolveStyle(merged.bold),
    italic: resolveStyle(merged.italic),
    selectedPrefix: resolveStyle(merged.selectedPrefix),
  };
}

export function loadTheme(name?: string): ResolvedTheme {
  const themeName = name ?? DEFAULT_THEME_NAME;

  // Built-in default — no file lookup needed.
  if (themeName === DEFAULT_THEME_NAME) {
    return resolveTheme(BUILTIN_DEFAULT);
  }

  const path = join(THEMES_DIR, `${themeName}.json`);
  if (!existsSync(path)) {
    process.stderr.write(
      `[theme] ${themeName} not found at ${path}; falling back to default\n`,
    );
    return resolveTheme(BUILTIN_DEFAULT);
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CliTheme;
    return resolveTheme(parsed);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[theme] failed to load ${themeName}: ${msg}; falling back to default\n`,
    );
    return resolveTheme(BUILTIN_DEFAULT);
  }
}

/**
 * List installed custom themes by name (excluding the built-in default).
 * Used by `agentboster themes` if we add that command later.
 */
export function listCustomThemes(): string[] {
  if (!existsSync(THEMES_DIR)) {
    return [];
  }
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

export { DEFAULT_THEME_NAME };
