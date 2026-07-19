/**
 * UI capabilities example extension.
 *
 * Demonstrates the UI surface extensions can use to integrate with the
 * chat / TUI chrome:
 *
 *   1. `registerShortcut` — bind a key chord to an action
 *   2. `registerFlag` — add a togglable flag to the status line
 *   3. `registerMessageRenderer` — render a custom message type in chat
 *   4. `ctx.ui.notify` / `setStatus` / `setFooter` — push transient
 *      status to the host UI
 *   5. `pi.on('turn_end')` — observe turn lifecycle for UI updates
 *
 * All of these are best-effort: in TUI mode they affect the terminal
 * UI; in RPC mode (when the desktop app is the UI) most of them forward
 * over the bridge to the desktop's status line / notification system;
 * in print mode they're no-ops. Extensions should call them without
 * guarding on mode — the host knows what to do.
 */

import { Type } from 'typebox';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionShortcut,
  ExtensionFlag,
} from '@agentboster/sdk';

// Custom message type — anything the extension wants to render in chat.
// Common use cases: progress cards, structured tool results, custom
// cards from external integrations.
interface ProgressCard {
  kind: 'progress-card';
  title: string;
  percent: number;
}

const FOCUS_MODE_FLAG = 'focus-mode';

export default function uiCapabilities(pi: ExtensionAPI): void {
  // (1) Shortcut — Ctrl+Alt+F toggles "focus mode" (silences notifications)
  const focusShortcut: ExtensionShortcut = {
    keyId: 'ctrl+alt+f',
    description: 'Toggle focus mode',
    action: () => {
      const current = pi.getFlag(FOCUS_MODE_FLAG)?.value ?? false;
      pi.registerFlag(FOCUS_MODE_FLAG, {
        description: 'When on, suppresses non-critical notifications.',
        value: !current,
      });
    },
  };
  pi.registerShortcut('focus-mode-toggle', focusShortcut);

  // (2) Flag — appears in the status line; can be read by other extensions
  //     via `pi.getFlag(FOCUS_MODE_FLAG)` and by the host's chrome.
  pi.registerFlag(FOCUS_MODE_FLAG, {
    description: 'When on, suppresses non-critical notifications.',
    value: false,
  });

  // (3) Custom message renderer — when any extension (or the host) emits
  //     a custom message with type='progress-card', we render it as a
  //     TUI progress bar. The desktop app renders it as a card.
  pi.registerMessageRenderer('progress-card', {
    render(message, { theme }) {
      const card = message as ProgressCard;
      const bar = renderProgressBar(card.percent);
      return {
        // text is shown in TUI mode; the desktop renders the full block.
        text: `${card.title} ${bar} ${card.percent.toFixed(0)}%`,
        // block lets the desktop show a richer card (ignored in TUI).
        block: {
          type: 'card',
          title: card.title,
          body: `${bar} ${card.percent.toFixed(0)}%`,
        },
      };
    },
  });

  // (4) Tool that emits a progress-card custom message over time.
  pi.registerTool({
    name: 'long_running_demo',
    label: 'LongRunningDemo',
    description:
      'Demo tool that emits progress-card custom messages at 25/50/75/100%.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      for (const pct of [25, 50, 75, 100]) {
        if (signal?.aborted) break;
        await sleep(250);

        // Emit a custom message that our renderer (registered above)
        // will pick up. Other extensions' renderers can also handle
        // 'progress-card' if they want.
        ctx.ui.custom?.({
          type: 'progress-card',
          title: 'Demo progress',
          percent: pct,
        });

        onUpdate?.({
          content: [{ type: 'text', text: `Reached ${pct}%` }],
        });
      }
      return {
        content: [{ type: 'text', text: 'Demo complete.' }],
      };
    },
  });

  // (5) Lifecycle — show a status pill on every turn and clear it after.
  pi.on('turn_start', () => {
    // These are best-effort; in RPC mode they're forwarded to the
    // desktop's status area, in TUI they hit the bottom bar, in print
    // mode they're silent.
    pi.setStatus?.('ui-demo:turn', 'thinking…');
    const focusOn = pi.getFlag(FOCUS_MODE_FLAG)?.value === true;
    if (!focusOn) {
      // notify() goes to the desktop notification center on macOS / a
      // libnotify popup on Linux / a toast in the desktop app.
      pi.notify?.('Turn started', 'info');
    }
  });

  pi.on('turn_end', () => {
    pi.setStatus?.('ui-demo:turn', undefined);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderProgressBar(percent: number): string {
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  return `[${'#'.repeat(filled).padEnd(width, '-')}]`;
}
