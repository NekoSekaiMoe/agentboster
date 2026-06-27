import chalk from 'chalk';
import type { ColorPalette } from './colors';

/**
 * Style helpers built on a ColorPalette. All chalk named-color usage
 * in the codebase MUST go through this module — calling chalk.cyan /
 * chalk.gray / chalk.red directly is forbidden.
 *
 * Why not cache these at module top level: theme switching must take
 * effect within a single render, so styles are constructed on the
 * render path from the current palette (see currentTheme below).
 */
export type Styles = {
  /** Color a string with the named palette token. */
  fg(token: keyof ColorPalette, text: string): string;
  /** Color + bold. */
  boldFg(token: keyof ColorPalette, text: string): string;
  /** Color + dim. */
  dimFg(token: keyof ColorPalette, text: string): string;
  /** Color + italic. */
  italicFg(token: keyof ColorPalette, text: string): string;
  /** Color + underline. */
  underlineFg(token: keyof ColorPalette, text: string): string;

  // Convenience aliases — semantic shortcuts for the most common cases.
  primary(text: string): string;
  accent(text: string): string;
  text(text: string): string;
  textStrong(text: string): string;
  textDim(text: string): string;
  textMuted(text: string): string;
  border(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  roleUser(text: string): string;
  roleAssistant(text: string): string;
  roleTool(text: string): string;

  // Pass-through helpers for non-color styles.
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  strikethrough(text: string): string;
};

export function createStyles(colors: ColorPalette): Styles {
  const fg = (token: keyof ColorPalette, text: string): string =>
    chalk.hex(colors[token])(text);
  const boldFg = (token: keyof ColorPalette, text: string): string =>
    chalk.hex(colors[token]).bold(text);
  const dimFg = (token: keyof ColorPalette, text: string): string =>
    chalk.hex(colors[token]).dim(text);
  const italicFg = (token: keyof ColorPalette, text: string): string =>
    chalk.hex(colors[token]).italic(text);
  const underlineFg = (token: keyof ColorPalette, text: string): string =>
    chalk.hex(colors[token]).underline(text);

  return {
    fg,
    boldFg,
    dimFg,
    italicFg,
    underlineFg,

    primary: (s) => fg('primary', s),
    accent: (s) => fg('accent', s),
    text: (s) => fg('text', s),
    textStrong: (s) => fg('textStrong', s),
    textDim: (s) => fg('textDim', s),
    textMuted: (s) => fg('textMuted', s),
    border: (s) => fg('border', s),
    success: (s) => fg('success', s),
    warning: (s) => fg('warning', s),
    error: (s) => fg('error', s),
    roleUser: (s) => fg('roleUser', s),
    roleAssistant: (s) => fg('roleAssistant', s),
    roleTool: (s) => fg('roleTool', s),

    bold: (s) => chalk.bold(s),
    dim: (s) => chalk.dim(s),
    italic: (s) => chalk.italic(s),
    underline: (s) => chalk.underline(s),
    strikethrough: (s) => chalk.strikethrough(s),
  };
}
