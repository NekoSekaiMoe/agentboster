/**
 * Export-HTML templates and vendored libraries, inlined into the bundle
 * via esbuild's text loader (`*.html`, `*.css`) and JS loader
 * (`*.js`). Replaces the previous readFileSync-at-runtime load (which
 * required the template files to ship alongside agentboster.cjs).
 */
import templateHtml from './template.html';
import templateCss from './template.css';
import templateJs from './template.js';
import markedMinJs from './vendor/marked.min.js';
import highlightMinJs from './vendor/highlight.min.js';

export const EXPORT_TEMPLATES = {
  html: templateHtml as unknown as string,
  css: templateCss as unknown as string,
  js: templateJs as unknown as string,
  markedJs: markedMinJs as unknown as string,
  hljsJs: highlightMinJs as unknown as string,
};
