/**
 * Export-HTML templates and vendored libraries, loaded at runtime from the
 * files that copy-assets ships alongside both layouts:
 *
 * - dist layout: packages/coding-agent/dist/core/export-html/{template.html,...}
 * - source/jiti (dev + extension loader): src/core/export-html/{...}
 * - single-file bundle: resolve relative to __dirname (dist/) first, then
 *   fall back to the source tree layout via import.meta.url.
 *
 * The previous static-import approach (esbuild text loader inlining) broke
 * the extension loader: jiti transforms extension code and its workspace
 * aliases, but a native Node pass over dist/index.js then fails on the
 * `import './template.html'` statements with ERR_UNKNOWN_FILE_EXTENSION.
 * Runtime reads keep a single code path that works in every mode.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readAsset(...candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next candidate
    }
  }
  return '';
}

function loadAsset(name: string): string {
  return readAsset(
    // dist layout (this file compiles to dist/core/export-html/templates.js)
    join(__dirname, name),
    // source layout (src/core/export-html/) when running via tsx/jiti from src
    join(__dirname, '..', '..', '..', 'src', 'core', 'export-html', name),
    // single-file bundle lives in dist/: dist/core/export-html/ relative to it
    join(__dirname, 'core', 'export-html', name),
  );
}

function loadVendor(name: string): string {
  return loadAsset(join('vendor', name));
}

export const EXPORT_TEMPLATES = {
  html: loadAsset('template.html'),
  css: loadAsset('template.css'),
  js: loadAsset('template.js'),
  markedJs: loadVendor('marked.min.js'),
  hljsJs: loadVendor('highlight.min.js'),
};
