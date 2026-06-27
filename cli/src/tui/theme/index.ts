import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ColorPalette,
  darkColors,
  DEFAULT_THEME_KIND,
  type ThemeKind,
  lightColors,
  type UserThemeFile,
} from './colors';
import { type Styles, createStyles } from './styles';

export type Theme = {
  kind: ThemeKind;
  colors: ColorPalette;
  styles: Styles;
};

export type { Styles, ColorPalette, ThemeKind };

let activeTheme: Theme = compileTheme(DEFAULT_THEME_KIND, {});

/**
 * Read the active theme. Callers MUST call this on the render path,
 * not cache the result at module top level — theme switches must take
 * effect within a single render.
 */
export function currentTheme(): Theme {
  return activeTheme;
}

/**
 * Switch the active theme at runtime. Re-compiles styles from the new
 * palette so subsequent renders pick them up.
 */
export function applyTheme(
  kind: ThemeKind,
  overrides?: Partial<ColorPalette>,
): void {
  activeTheme = compileTheme(kind, overrides ?? {});
}

function baseFor(kind: ThemeKind): ColorPalette {
  return kind === 'light' ? lightColors : darkColors;
}

function compileTheme(
  kind: ThemeKind,
  overrides: Partial<ColorPalette>,
): Theme {
  const colors: ColorPalette = { ...baseFor(kind), ...overrides };
  return { kind, colors, styles: createStyles(colors) };
}

/**
 * Load a user-installed theme by name (no extension). Looks for
 * ~/.agentboster/themes/<name>.json; on any failure, falls back to
 * the default dark theme with a stderr warning.
 */
export function loadUserTheme(name?: string): Theme {
  if (!name || name === 'default' || name === DEFAULT_THEME_KIND) {
    return compileTheme(DEFAULT_THEME_KIND, {});
  }

  const path = join(homedir(), '.agentboster', 'themes', `${name}.json`);
  if (!existsSync(path)) {
    process.stderr.write(
      `[theme] ${name} not found at ${path}; using default\n`,
    );
    return compileTheme(DEFAULT_THEME_KIND, {});
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const file = JSON.parse(raw) as UserThemeFile;
    return compileTheme(file.kind ?? DEFAULT_THEME_KIND, file.overrides ?? {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[theme] failed to load ${name}: ${msg}; using default\n`,
    );
    return compileTheme(DEFAULT_THEME_KIND, {});
  }
}

/**
 * Persist the active theme for this TUI session. Wraps applyTheme so
 * callers don't have to know about palettes — they just pass a user
 * theme name from config or 'default'.
 */
export function activateUserTheme(name?: string): void {
  const theme = loadUserTheme(name);
  activeTheme = theme;
}
