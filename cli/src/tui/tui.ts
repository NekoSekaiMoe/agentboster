import { randomUUID } from 'node:crypto';
import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
} from '@earendil-works/pi-tui';
import {
  ensureConfig,
  getActiveDeployment,
  loadConfig,
  type CliDeployment,
} from '../lib/config';
import { createApiClient, createStreamFetcher } from '../lib/api';
import { activateUserTheme, currentTheme, type Theme } from './theme';
import { buildEditorTheme } from './theme/pi-tui-theme';
import { buildStatusLine, setStatusLine } from './components/status-line';
import { buildTranscript, renderTranscript } from './components/transcript';
import { createInitialState, type TUIState } from './tui-state';
import { AuthController } from './controllers/auth';
import { ChatController } from './controllers/chat';
import { LocalToolsController } from './controllers/local-tools';
import { PickersController } from './controllers/pickers';

/**
 * Coordinator. Wires state, layout, editor, controllers, and global
 * key handling. Holds the mutable client slots (apiClient / streamFetch)
 * that controllers read after a runtime login swap.
 *
 * Mirrors kimi-code's KimiTUI philosophy: wiring only, no business
 * rules in this file.
 */
export class TuiHost {
  state: TUIState;
  tui: TUI;
  theme: Theme;
  apiClient: ReturnType<typeof createApiClient> | null;
  streamFetch: ReturnType<typeof createStreamFetcher> | null;
  auth: AuthController;
  chat: ChatController;
  localTools: LocalToolsController;
  pickers: PickersController;

  private readonly transcript = buildTranscript();
  private readonly statusLine = buildStatusLine();
  private readonly editor: Editor;

  constructor(options: {
    sessionId?: string;
    deployment?: string;
    model?: string;
  }) {
    const loaded = loadConfig();
    const config = loaded ?? ensureConfig();
    activateUserTheme(config.theme);
    this.theme = currentTheme();
    const active = getActiveDeployment(config, options.deployment);
    this.state = createInitialState({
      config,
      deployment: active,
      sessionId: options.sessionId ?? randomUUID(),
      model: options.model,
    });
    this.apiClient = active ? createApiClient(active.deployment) : null;
    this.streamFetch = active ? createStreamFetcher(active.deployment) : null;

    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);

    this.editor = new Editor(this.tui, buildEditorTheme(this.theme.styles));
    this.editor.onSubmit = (text) => this.handleSubmit(text);

    this.auth = new AuthController(this);
    this.chat = new ChatController(this);
    this.localTools = new LocalToolsController(this);
    this.pickers = new PickersController(this);

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.statusLine);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);

    this.tui.addInputListener((data) => this.handleKey(data));
  }

  setStatus(content: string): void {
    setStatusLine(this.statusLine, content);
    this.tui.requestRender();
  }

  render(): void {
    renderTranscript(this.transcript, this.state);
    this.tui.requestRender();
  }

  start(): void {
    this.render();
    if (this.state.phase.kind === 'unauthenticated') {
      this.setStatus(
        this.theme.styles.textDim(
          'type /login <url> <username> <password> and press Enter',
        ),
      );
    } else {
      this.setStatus(
        this.theme.styles.textDim(
          'ready — Enter to send · Ctrl+P sessions · Ctrl+L models · Ctrl+C ×2 quit',
        ),
      );
    }
    this.tui.start();
  }

  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.startsWith('/login')) {
      void this.auth.handleLoginCommand(trimmed);
      return;
    }
    if (trimmed === '/help') {
      this.setStatus(
        this.theme.styles.textDim(
          '/login <url> <user> <pass> · Ctrl+P sessions · Ctrl+L models · Ctrl+C ×2 quit',
        ),
      );
      return;
    }
    if (this.state.phase.kind === 'unauthenticated') {
      this.setStatus(
        this.theme.styles.error(
          'Not logged in. Type /login <url> <username> <password>',
        ),
      );
      return;
    }
    void this.chat.sendMessage(text);
  }

  private ctrlCState = {
    count: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  };

  private handleKey(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.ctrlCState.count += 1;
      if (this.ctrlCState.count >= 2) {
        this.tui.stop();
        process.exit(0);
      }
      this.setStatus(this.theme.styles.warning('Press Ctrl+C again to quit'));
      if (this.ctrlCState.timer) clearTimeout(this.ctrlCState.timer);
      this.ctrlCState.timer = setTimeout(() => {
        this.ctrlCState.count = 0;
      }, 1500);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('p'))) {
      this.pickers.showSessionPicker();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      this.pickers.showModelPicker();
      return { consume: true };
    }
    return undefined;
  }
}

export async function runTui(options: {
  sessionId?: string;
  deployment?: string;
  model?: string;
}): Promise<void> {
  const host = new TuiHost(options);
  host.start();
}

export type { CliDeployment };
