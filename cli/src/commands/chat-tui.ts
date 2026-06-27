import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import {
  Container,
  Editor,
  type EditorTheme,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from '@earendil-works/pi-tui';
import { ensureConfig, getActiveDeployment, loadConfig } from '../lib/config';
import { createStreamFetcher } from '../lib/api';
import { readSseStream, type UiMessageChunk } from '../lib/sse';

/**
 * Interactive TUI chat. Renders an editor for input + a scrolling list
 * of rendered Markdown turns. State machine:
 *   ready → streaming → ready (or error)
 *
 * Layout (top to bottom):
 *   - message turns (user + assistant, Markdown rendered)
 *   - streaming assistant turn (if active)
 *   - status line (one line)
 *   - editor (multi-line input, submits on Enter)
 */

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

type AppState =
  | { kind: 'ready' }
  | { kind: 'streaming'; runId?: string }
  | { kind: 'error'; message: string };

const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.cyan(s),
  selectList: {
    selectedPrefix: (s) => chalk.cyan(s),
    selectedText: (s) => chalk.cyan.bold(s),
    description: (s) => chalk.gray(s),
    scrollInfo: (s) => chalk.gray(s),
    noMatch: (s) => chalk.gray(s),
  },
};

const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold(s),
  link: (s) => chalk.blue(s),
  linkUrl: (s) => chalk.gray(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.dim(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

export async function chatTuiCommand(options: {
  sessionId?: string;
  deployment?: string;
}): Promise<void> {
  const loaded = loadConfig();
  if (!loaded) {
    console.error(
      'Not logged in. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const config = ensureConfig();
  const active = getActiveDeployment(config, options.deployment);
  if (!active) {
    console.error(
      'No configured deployment. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const sessionId = options.sessionId ?? randomUUID();
  const streamFetch = createStreamFetcher(active.deployment);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const turns: Turn[] = [];
  let streamingText = '';
  let state: AppState = { kind: 'ready' };

  const messagesContainer = new Container();
  const statusText = new Text('', 0, 0, (s: string) => chalk.gray(s));
  const editor = new Editor(tui, editorTheme);

  function rebuildMessages(): void {
    messagesContainer.clear();
    for (const turn of turns) {
      const prefix =
        turn.role === 'user' ? chalk.cyan('you:') : chalk.magenta('assistant:');
      messagesContainer.addChild(new Text(prefix, 0, 0));
      messagesContainer.addChild(new Markdown(turn.text, 1, 1, markdownTheme));
      messagesContainer.addChild(new Spacer(1));
    }
    if (streamingText) {
      messagesContainer.addChild(new Text(chalk.magenta('assistant:'), 0, 0));
      messagesContainer.addChild(
        new Markdown(streamingText, 1, 1, markdownTheme),
      );
    }
    tui.requestRender();
  }

  function setStatus(text: string): void {
    statusText.setText(text);
    tui.requestRender();
  }

  async function sendMessage(text: string): Promise<void> {
    if (state.kind === 'streaming') return;
    if (!text.trim()) return;

    turns.push({ id: randomUUID(), role: 'user', text });
    streamingText = '';
    state = { kind: 'streaming' };
    setStatus(chalk.cyan('thinking…'));
    rebuildMessages();

    let runId: string | undefined;
    try {
      const response = await streamFetch('/api/cli/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          id: sessionId,
          trigger: 'submit-message',
          input: { text },
          clientId: config.clientId,
          label: config.label,
        }),
      });

      if (!response.ok) {
        let errorText = `${response.status} ${response.statusText}`;
        try {
          const body = (await response.json()) as {
            message?: string;
            error?: string;
          };
          errorText = body.message ?? body.error ?? errorText;
        } catch {
          // ignore json parse failure
        }
        state = { kind: 'error', message: errorText };
        setStatus(chalk.red(`error: ${errorText}`));
        return;
      }

      runId = response.headers.get('x-workflow-run-id') ?? undefined;
      state = { kind: 'streaming', runId };

      for await (const chunk of readSseStream(response)) {
        handleChunk(chunk);
      }

      if (streamingText) {
        turns.push({
          id: randomUUID(),
          role: 'assistant',
          text: streamingText,
        });
        streamingText = '';
      }
      state = { kind: 'ready' };
      setStatus(chalk.gray('ready'));
      rebuildMessages();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      state = { kind: 'error', message: msg };
      setStatus(chalk.red(`error: ${msg}`));
    }
  }

  function handleChunk(chunk: UiMessageChunk): void {
    if (chunk.type === 'text-delta') {
      const delta = (chunk as { delta?: string }).delta;
      if (typeof delta === 'string') {
        streamingText += delta;
        rebuildMessages();
      }
      return;
    }

    if (chunk.type === 'error') {
      const text = (chunk as { errorText?: string }).errorText;
      if (text) setStatus(chalk.red(`stream error: ${text}`));
      return;
    }

    if (chunk.type === 'data-workflow') {
      const data = (chunk as { data?: { kind: string; type: string } }).data;
      if (data?.kind === 'status' && data.type === 'local-tool-request') {
        const req = chunk as unknown as {
          data: {
            toolCallId: string;
            toolName: string;
            toolInput: unknown;
          };
        };
        setStatus(
          chalk.gray(
            `[local tool: ${req.data.toolName}] — stage D will execute`,
          ),
        );
      }
    }
  }

  editor.onSubmit = (text: string) => {
    void sendMessage(text);
  };

  // Ctrl+C twice to quit (pi-tui runs in raw mode).
  let ctrlCCount = 0;
  let ctrlCResetTimer: ReturnType<typeof setTimeout> | null = null;
  tui.addInputListener((data: string) => {
    if (matchesKey(data, Key.ctrl('c'))) {
      ctrlCCount += 1;
      if (ctrlCCount >= 2) {
        tui.stop();
        process.exit(0);
      }
      setStatus(chalk.yellow('Press Ctrl+C again to quit'));
      if (ctrlCResetTimer) clearTimeout(ctrlCResetTimer);
      ctrlCResetTimer = setTimeout(() => {
        ctrlCCount = 0;
      }, 1500);
      return { consume: true };
    }
    return undefined;
  });

  tui.addChild(messagesContainer);
  tui.addChild(statusText);
  tui.addChild(editor);

  tui.setFocus(editor);
  setStatus(
    chalk.gray(
      'ready — type a message and press Enter to send (Ctrl+C twice to quit)',
    ),
  );
  tui.start();
}
