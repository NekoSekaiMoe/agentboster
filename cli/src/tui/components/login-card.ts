import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { currentTheme } from '../theme';

/**
 * Rounded-border card shown in the transcript when the TUI is in the
 * `unauthenticated` phase. Renders a title + a short explanation +
 * the inline `/login` recipe. Inspired by kimi-code's device-code-box
 * (ref/apps/kimi-code/src/tui/components/chrome/device-code-box.ts)
 * but trimmed for our username/password flow.
 */
export class LoginCardComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    const styles = currentTheme().styles;
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const title = styles.boldFg('textStrong', 'agentboster — first-time setup');
    const prompt = styles.textDim(
      'Type the command below in the editor, then press Enter:',
    );
    const recipe = styles.primary('/login <url> <username> <password>');
    const example = styles.textMuted(
      'example: /login https://my.example.com alice mypass123',
    );
    const alt = styles.textDim(
      'or press Ctrl+C twice to quit and run `agentboster login` from your shell',
    );

    const contentLines = [title, '', prompt, recipe, '', example, '', alt].map(
      (line) => truncateToWidth(line, innerWidth, '…'),
    );

    if (safeWidth < 4) {
      return [
        '',
        ...contentLines.map((l) => truncateToWidth(l, safeWidth, '…')),
      ];
    }

    const border = (s: string) => styles.accent(s);
    const hbar = '─'.repeat(safeWidth - 2);
    const lines: string[] = [
      '',
      border(`╭${hbar}╮`),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(
        border('│') + pad + content + ' '.repeat(rightPad) + border('│'),
      );
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border(`╰${hbar}╯`));
    lines.push('');

    return lines.map((l) => truncateToWidth(l, safeWidth, '…'));
  }
}
