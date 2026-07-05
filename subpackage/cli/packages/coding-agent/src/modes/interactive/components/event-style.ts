import type { Theme, ThemeColor } from '../theme/theme.ts';

export function formatEventLine(
  theme: Theme,
  title: string,
  options: { bulletColor?: ThemeColor } = {},
): string {
  const bulletColor = options.bulletColor ?? 'success';
  return `${theme.fg(bulletColor, '·')} ${title}`;
}

export function formatEventChildLine(theme: Theme, line: string): string {
  return `${theme.fg('dim', '└')} ${line}`;
}

export function formatEventChildLines(theme: Theme, lines: string[]): string[] {
  return lines.map((line, index) =>
    index === 0
      ? formatEventChildLine(theme, line)
      : `${theme.fg('dim', ' ')} ${line}`,
  );
}

export function formatEventChildBlock(theme: Theme, block: string): string {
  return formatEventChildLines(theme, block.split('\n')).join('\n');
}

export function formatShellCommand(theme: Theme, command: string): string {
  return command
    .split(/(\s+)/)
    .map((part, index) => {
      if (!part.trim()) return part;
      if (part.startsWith('-')) return theme.fg('mdLink', part);
      if (index === 0) return theme.fg('toolOutput', part);
      return part;
    })
    .join('');
}
