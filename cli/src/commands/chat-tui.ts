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
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  TUI,
} from '@earendil-works/pi-tui';
import { ensureConfig, getActiveDeployment, loadConfig } from '../lib/config';
import {
  createApiClient,
  createStreamFetcher,
  type ListModelsResponse,
  type ListSessionsResponse,
  type SessionListItem,
} from '../lib/api';
import { executeLocalTool } from '../lib/local-tools';
import { readSseStream, type UiMessageChunk } from '../lib/sse';
import { loadTheme, type ResolvedTheme } from '../lib/theme';

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

function buildEditorTheme(theme: ResolvedTheme): EditorTheme {
  return {
    borderColor: theme.border,
    selectList: {
      selectedPrefix: theme.selectedPrefix,
      selectedText: (s) => chalk.bold(s),
      description: (s) => chalk.gray(s),
      scrollInfo: (s) => chalk.gray(s),
      noMatch: (s) => chalk.gray(s),
    },
  };
}

function buildMarkdownTheme(theme: ResolvedTheme): MarkdownTheme {
  return {
    heading: theme.heading,
    link: theme.link,
    linkUrl: (s) => chalk.gray(s),
    code: theme.code,
    codeBlock: (s) => chalk.dim(s),
    codeBlockBorder: (s) => chalk.dim(s),
    quote: (s) => chalk.italic(s),
    quoteBorder: (s) => chalk.dim(s),
    hr: (s) => chalk.dim(s),
    listBullet: theme.selectedPrefix,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: (s) => chalk.strikethrough(s),
    underline: (s) => chalk.underline(s),
  };
}

function buildSelectListTheme(theme: ResolvedTheme): SelectListTheme {
  return {
    selectedPrefix: theme.selectedPrefix,
    selectedText: (s) => chalk.bold(s),
    description: (s) => chalk.gray(s),
    scrollInfo: (s) => chalk.gray(s),
    noMatch: (s) => chalk.gray(s),
  };
}

export async function chatTuiCommand(options: {
  sessionId?: string;
  deployment?: string;
  model?: string;
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

  // Mutable sessionId holder so switchToSession can change it. The TUI
  // session can be swapped at runtime via Ctrl+P; without a holder the
  // const binding would shadow the new value.
  const activeSessionIdHolder: { value: string } = {
    value: options.sessionId ?? randomUUID(),
  };
  const streamFetch = createStreamFetcher(active.deployment);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const turns: Turn[] = [];
  let streamingText = '';
  let state: AppState = { kind: 'ready' };
  let currentModel = options.model ?? null;

  const theme = loadTheme(config.theme);
  const editorTheme = buildEditorTheme(theme);
  const markdownTheme = buildMarkdownTheme(theme);
  const selectListTheme = buildSelectListTheme(theme);

  const messagesContainer = new Container();
  // Status text uses identity — callers pass already-styled chalk output.
  const statusText = new Text('', 0, 0);
  const editor = new Editor(tui, editorTheme);
  const apiClient = createApiClient(active.deployment);

  function rebuildMessages(): void {
    messagesContainer.clear();
    for (const turn of turns) {
      const prefix =
        turn.role === 'user'
          ? theme.userPrefix('you:')
          : theme.assistantPrefix('assistant:');
      messagesContainer.addChild(new Text(prefix, 0, 0));
      messagesContainer.addChild(new Markdown(turn.text, 1, 1, markdownTheme));
      messagesContainer.addChild(new Spacer(1));
    }
    if (streamingText) {
      messagesContainer.addChild(
        new Text(theme.assistantPrefix('assistant:'), 0, 0),
      );
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
    setStatus(theme.statusStreaming('thinking…'));
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
          id: activeSessionIdHolder.value,
          trigger: 'submit-message',
          input: { text },
          clientId: config.clientId,
          label: config.label,
          ...(currentModel ? { model: currentModel } : {}),
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
        setStatus(theme.statusError(`error: ${errorText}`));
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
      setStatus(theme.status('ready'));
      rebuildMessages();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      state = { kind: 'error', message: msg };
      setStatus(theme.statusError(`error: ${msg}`));
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
      if (text) setStatus(theme.statusError(`stream error: ${text}`));
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
        // Don't await — fire-and-forget so the SSE loop keeps reading.
        // The workflow will pause on the localToolResultHookBuilder until
        // we POST the result; meanwhile we need to keep draining the
        // stream for any subsequent chunks (e.g. another tool call).
        void executeAndPostLocalTool(req.data);
      }
    }
  }

  async function executeAndPostLocalTool(req: {
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
  }): Promise<void> {
    setStatus(
      theme.status(`[local tool] ${req.toolName} — executing on this machine…`),
    );

    const result = await executeLocalTool(req.toolName, req.toolInput);

    setStatus(
      theme.status(
        `[local tool] ${req.toolName} — ${result.ok ? 'ok' : 'failed'}, posting result…`,
      ),
    );

    if (state.kind !== 'streaming' || !state.runId) {
      // No runId means we never got the header. Should not happen in
      // practice — the SSE stream always starts with a runId response —
      // but bail cleanly if it does.
      setStatus(
        theme.statusError(
          `[local tool] ${req.toolName} — cannot post result (no active runId)`,
        ),
      );
      return;
    }

    try {
      const res = await streamFetch(`/api/ai/${state.runId}/tool-result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolCallId: req.toolCallId,
          ok: result.ok,
          output: result.output,
          error: result.error,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setStatus(
          theme.statusError(
            `[local tool] ${req.toolName} — POST failed: ${res.status} ${text.slice(0, 200)}`,
          ),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(
        theme.statusError(`[local tool] ${req.toolName} — POST error: ${msg}`),
      );
    }
  }

  editor.onSubmit = (text: string) => {
    void sendMessage(text);
  };

  // ── Session + Model pickers (Ctrl+P / Ctrl+L) ────────────────────────
  // Both load their list from the /api/cli/* REST routes, show a pi-tui
  // overlay with SelectList, and apply the choice.

  async function loadSessionsList(): Promise<SessionListItem[]> {
    const params = new URLSearchParams({ limit: '50' });
    const res = await apiClient<ListSessionsResponse>(
      `/api/cli/sessions?${params}`,
    );
    return res.ok ? res.sessions : [];
  }

  async function loadModelsList(): Promise<
    Array<{ id: string; isDefault: boolean }>
  > {
    const res = await apiClient<ListModelsResponse>('/api/cli/models');
    if (!res.ok) return [];
    return res.models.map((m) => ({
      id: m.id,
      isDefault: m.id === res.defaultModel,
    }));
  }

  function showSessionPicker(): void {
    if (state.kind === 'streaming') {
      setStatus(chalk.yellow('Wait for the current turn to finish.'));
      return;
    }
    setStatus(theme.status('Loading sessions…'));
    void (async () => {
      let sessions: SessionListItem[];
      try {
        sessions = await loadSessionsList();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setStatus(theme.statusError(`Failed to load sessions: ${msg}`));
        return;
      }
      if (sessions.length === 0) {
        setStatus(theme.status('No sessions found on this machine.'));
        return;
      }
      const items: SelectItem[] = sessions.map((s) => ({
        value: s.id,
        label: s.title?.trim() || '(untitled)',
        description: `${s.channel} · ${s.id.slice(0, 8)}… · ${new Date(s.updatedAt).toLocaleString()}`,
      }));
      const list = new SelectList(items, 10, selectListTheme);
      list.onSelect = (item: SelectItem) => {
        tui.hideOverlay();
        void switchToSession(item.value);
      };
      list.onCancel = () => {
        tui.hideOverlay();
        setStatus(theme.status('ready'));
      };
      tui.showOverlay(list, {
        width: '80%',
        maxHeight: 20,
        anchor: 'top-center',
      });
      setStatus('');
    })();
  }

  function showModelPicker(): void {
    setStatus(theme.status('Loading models…'));
    void (async () => {
      let models: Array<{ id: string; isDefault: boolean }>;
      try {
        models = await loadModelsList();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setStatus(theme.statusError(`Failed to load models: ${msg}`));
        return;
      }
      if (models.length === 0) {
        setStatus(
          chalk.gray(
            'No model catalog on server; pass --model <id> on startup instead.',
          ),
        );
        return;
      }
      const items: SelectItem[] = models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.isDefault ? 'server default' : '',
      }));
      const list = new SelectList(items, 10, selectListTheme);
      list.onSelect = (item: SelectItem) => {
        currentModel = item.value;
        tui.hideOverlay();
        setStatus(theme.status(`model: ${currentModel}`));
      };
      list.onCancel = () => {
        tui.hideOverlay();
        setStatus(
          chalk.gray(currentModel ? `model: ${currentModel}` : 'ready'),
        );
      };
      tui.showOverlay(list, {
        width: '60%',
        maxHeight: 15,
        anchor: 'top-center',
      });
      setStatus('');
    })();
  }

  async function switchToSession(newSessionId: string): Promise<void> {
    setStatus(theme.status(`Loading session ${newSessionId.slice(0, 8)}…`));
    // Reset local state — future turns POST against the new sessionId.
    turns.length = 0;
    streamingText = '';
    activeSessionIdHolder.value = newSessionId;
    rebuildMessages();
    setStatus(
      theme.status(
        `switched to ${newSessionId.slice(0, 8)}… — history not loaded yet; ask a question to continue`,
      ),
    );
  }

  // Ctrl+C twice to quit (pi-tui runs in raw mode). Ctrl+P opens the
  // session picker, Ctrl+L the model picker.
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
    if (matchesKey(data, Key.ctrl('p'))) {
      showSessionPicker();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      showModelPicker();
      return { consume: true };
    }
    return undefined;
  });

  tui.addChild(messagesContainer);
  tui.addChild(statusText);
  tui.addChild(editor);

  tui.setFocus(editor);
  setStatus(
    theme.status(
      'ready — Enter to send · Ctrl+P sessions · Ctrl+L models · Ctrl+C twice to quit',
    ),
  );
  tui.start();
}
