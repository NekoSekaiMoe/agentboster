import {
  type Component,
  type LoaderIndicatorOptions,
  truncateToWidth,
  type TUI,
} from '@agentboster-cli/tui';
import chalk from 'chalk';
import { theme } from '../theme/theme.ts';
import { keyText } from './keybinding-hints.ts';

const DEFAULT_INTERVAL_MS = 120;
const DEFAULT_INDICATOR = '·';
const GRADIENT = ['#f8fafc', '#67e8f9', '#22c55e', '#f8fafc'] as const;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function gradientColor(position: number): [number, number, number] {
  const scaled = position * (GRADIENT.length - 1);
  const index = Math.floor(scaled) % (GRADIENT.length - 1);
  const nextIndex = (index + 1) % GRADIENT.length;
  const local = scaled - Math.floor(scaled);
  const [r1, g1, b1] = hexToRgb(GRADIENT[index] ?? GRADIENT[0]);
  const [r2, g2, b2] = hexToRgb(GRADIENT[nextIndex] ?? GRADIENT[0]);
  return [lerp(r1, r2, local), lerp(g1, g2, local), lerp(b1, b2, local)];
}

function gradientText(text: string, phase: number): string {
  const chars = Array.from(text);
  const denom = Math.max(1, chars.length - 1);
  return chars
    .map((char, index) => {
      const [r, g, b] = gradientColor((index / denom + phase) % 1);
      return chalk.rgb(r, g, b)(char);
    })
    .join('');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function normalizeMessage(message: string): string {
  return message
    .replace(/\s*\([^)]*to interrupt\)\s*$/i, '')
    .replace(/\.\.\.$/, '')
    .trim();
}

export class WorkingLoader implements Component {
  private readonly ui: TUI;
  private message: string;
  private indicatorOptions: LoaderIndicatorOptions | undefined;
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout;
  private tick = 0;

  constructor(
    ui: TUI,
    message: string,
    indicatorOptions?: LoaderIndicatorOptions,
  ) {
    this.ui = ui;
    this.message = normalizeMessage(message);
    this.indicatorOptions = indicatorOptions;
    this.timer = this.startTimer();
  }

  setMessage(message: string): void {
    this.message = normalizeMessage(message);
    this.ui.requestRender();
  }

  setIndicator(options?: LoaderIndicatorOptions): void {
    this.indicatorOptions = options;
    clearInterval(this.timer);
    this.timer = this.startTimer();
    this.ui.requestRender();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const indicator = this.renderIndicator();
    const phase = (this.tick % 18) / 18;
    const label = gradientText(this.message || 'Working', phase);
    const meta = theme.fg(
      'muted',
      ` (${formatElapsed(Date.now() - this.startedAt)} · ${keyText('app.interrupt')} to interrupt)`,
    );
    const line = `${indicator}${label}${meta}`;
    return [truncateToWidth(line, width, '...')];
  }

  private renderIndicator(): string {
    const frames = this.indicatorOptions?.frames;
    if (frames && frames.length === 0) return '';
    if (frames && frames.length > 0) {
      const frame = frames[this.tick % frames.length] ?? '';
      return frame ? `${frame} ` : '';
    }
    return `${theme.fg('success', DEFAULT_INDICATOR)} `;
  }

  private startTimer(): NodeJS.Timeout {
    return setInterval(() => {
      this.tick++;
      this.ui.requestRender();
    }, this.indicatorOptions?.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}
