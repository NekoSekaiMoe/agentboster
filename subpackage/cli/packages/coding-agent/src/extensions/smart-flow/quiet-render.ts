// Ported from pi-maestro-flow (MIT, Copyright (c) 2026 catlog22)
// Source: packages/pi-maestro-flow/src/quiet-render.ts
// The cockpit-driven quiet-state module was inlined: we always use the default
// "check" glyph set.

import type { Theme } from '../../modes/interactive/theme/theme.ts';
import type { Component } from '@agentboster-cli/tui';
import { truncateToWidth } from '@agentboster-cli/tui';

type QuietStatus = 'running' | 'success' | 'failure';

function quietStatusMark(status: QuietStatus): string {
  if (status === 'running') return '…';
  if (status === 'success') return '✓';
  return '✕';
}

// A structural subset of the Theme so both the real Theme and other renderers'
// local themes satisfy it without contravariance errors.
export type QuietTheme = Pick<Theme, 'fg'> & Partial<Pick<Theme, 'bold'>>;

interface ResultLike {
  content: Array<{ type: string; text?: string }>;
}

function lineComponent(text: string): Component {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      return text
        .split('\n')
        .map((line) => truncateToWidth(line, safeWidth, '…'));
    },
    invalidate(): void {},
  };
}

export function toolCallLine(
  theme: QuietTheme,
  name: string,
  arg = '',
): Component {
  const bold = theme.bold ?? ((text: string) => text);
  return lineComponent(
    `  ${theme.fg('warning', quietStatusMark('running'))} ${theme.fg('toolTitle', bold(name))}${arg ? ` ${theme.fg('accent', arg)}` : ''}`,
  );
}

export function toolResultLine(
  theme: QuietTheme,
  o: {
    name: string;
    mark?: string;
    ok?: boolean;
    arg?: string;
    summary?: string;
    detail?: string;
    expanded?: boolean;
  },
): Component {
  const bold = theme.bold ?? ((text: string) => text);
  const mark =
    o.mark ??
    (o.ok === false
      ? theme.fg('error', quietStatusMark('failure'))
      : theme.fg('success', quietStatusMark('success')));
  let line = `  ${mark} ${theme.fg('toolTitle', bold(o.name))}${o.arg ? ` ${theme.fg('accent', o.arg)}` : ''}${o.summary ? ` ${theme.fg('dim', `· ${o.summary}`)}` : ''}`;
  if (o.expanded && o.detail && o.detail.trim()) {
    line += `\n${theme.fg('dim', o.detail)}`;
  }
  return lineComponent(line);
}

/** First non-empty line of a tool result's text content, truncated to maxLen. */
export function resultFirstLine(result: ResultLike, maxLen = 60): string {
  const text =
    result.content.find((c) => c.type === 'text' && c.text)?.text ?? '';
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/** Count of non-empty lines in a tool result's text content. */
export function resultLineCount(result: ResultLike): number {
  const text =
    result.content.find((c) => c.type === 'text' && c.text)?.text ?? '';
  return text.split('\n').filter((l) => l.trim()).length;
}

/**
 * Generic result summary: a short first line, falling back to a line count.
 * Keeps any tool's quiet result line meaningful without per-tool logic.
 */
export function resultSummary(result: ResultLike, maxLen = 60): string {
  const first = resultFirstLine(result, maxLen);
  if (first) return first;
  const n = resultLineCount(result);
  return n > 0 ? `${n} lines` : 'done';
}

/** One-line compact JSON of a value, whitespace-collapsed and truncated. For quiet call args. */
export function compactJson(value: unknown, maxLen = 50): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined || s === 'null') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
