/**
 * Semantic color palette. Single source of truth for every color the
 * TUI uses. Components read these via `currentTheme.fg('primary', s)`
 * etc. — direct `chalk.cyan/gray/...` calls are forbidden (mirrors
 * kimi-code's guard convention, see ref/apps/kimi-code/AGENTS.md).
 *
 * When adding a token: also seed both `darkColors` and `lightColors`,
 * keep light-theme contrast ≥ 4.5:1 for text / ≥ 3:1 for chrome.
 */
export interface ColorPalette {
  // Brand
  /** Editor border, picker selection, links, focused chrome. */
  primary: string;
  /** Secondary highlight: login-card border, secondary selection. */
  accent: string;

  // Text
  /** Default body text. */
  text: string;
  /** Bold / strong body text. */
  textStrong: string;
  /** Dimmed: hints, descriptions, secondary metadata. */
  textDim: string;
  /** Faintest: counters, scroll info, link URLs. */
  textMuted: string;

  // Surface
  /** Default border. */
  border: string;

  // State
  /** Success markers, ✓, "logged in", ok status. */
  success: string;
  /** Warnings, transient hints ("Press Ctrl+C again"). */
  warning: string;
  /** Errors, failures, "not logged in". */
  error: string;

  // Roles
  /** User message bullet + text. */
  roleUser: string;
  /** Assistant message bullet + text. */
  roleAssistant: string;
  /** Tool / system event bullet. */
  roleTool: string;
}

export const darkColors: ColorPalette = {
  primary: '#22d3ee', // cyan-400
  accent: '#a78bfa', // violet-400

  text: '#e5e7eb', // gray-200
  textStrong: '#f9fafb', // gray-50
  textDim: '#9ca3af', // gray-400
  textMuted: '#6b7280', // gray-500

  border: '#374151', // gray-700

  success: '#34d399', // emerald-400
  warning: '#fbbf24', // amber-400
  error: '#f87171', // red-400

  roleUser: '#22d3ee', // cyan-400 (matches primary)
  roleAssistant: '#a78bfa', // violet-400 (matches accent)
  roleTool: '#9ca3af', // gray-400
};

export const lightColors: ColorPalette = {
  primary: '#0891b2', // cyan-600 — 4.6:1 on white
  accent: '#7c3aed', // violet-600 — 5.4:1

  text: '#1f2937', // gray-800 — 12.6:1
  textStrong: '#111827', // gray-900 — 16:1
  textDim: '#4b5563', // gray-600 — 7.2:1
  textMuted: '#6b7280', // gray-500 — 4.7:1

  border: '#cbd5e1', // slate-300 — 3.1:1 (chrome)

  success: '#059669', // emerald-600 — 4.6:1
  warning: '#b45309', // amber-700 — 4.8:1
  error: '#b91c1c', // red-700 — 5.9:1

  roleUser: '#0891b2',
  roleAssistant: '#7c3aed',
  roleTool: '#4b5563',
};

export type ThemeKind = 'dark' | 'light';

export const DEFAULT_THEME_KIND: ThemeKind = 'dark';

/**
 * User theme override file (from ~/.agentboster/themes/<name>.json).
 * Any subset of tokens; missing fields fall back to the base palette
 * for the active kind.
 */
export type UserThemeFile = {
  kind?: ThemeKind;
  overrides?: Partial<ColorPalette>;
};
