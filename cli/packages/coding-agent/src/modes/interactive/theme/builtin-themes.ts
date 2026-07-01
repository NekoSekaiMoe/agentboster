/**
 * Built-in color themes, inlined into the bundle via esbuild's JSON
 * loader. Replaces the previous readFileSync-at-runtime load (which
 * required dark.json/light.json to ship alongside agentboster.cjs).
 */
import darkJson from './dark.json';
import lightJson from './light.json';
import type { ThemeJson } from './theme.ts';

export const BUILTIN_THEMES: Record<string, ThemeJson> = {
  dark: darkJson as unknown as ThemeJson,
  light: lightJson as unknown as ThemeJson,
};
