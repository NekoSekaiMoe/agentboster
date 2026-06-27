import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CLI_CONFIG_FILE, type CliConfig } from './lib/config';
import {
  createApiClient,
  readUiMessageStream,
  type CliModel,
  type CliSession,
  type LocalToolResultPayload,
} from './lib/api';
import { readJson } from './lib/store';
import { loginCommand } from './commands/login';
import { pairCommand } from './commands/pair';
import { executeLocalTool, evaluateLocalCommand } from './lib/local-security';

type TuiState = {
  baseUrl: string;
  token?: string;
  models: CliModel[];
  defaultModel: string | null;
  sessions: CliSession[];
  currentSessionId: string | null;
  currentMessages: { role: string; content: string }[];
};

type LocalHistoryEntry = {
  kind: 'info' | 'error' | 'tool';
  text: string;
};

type LocalToolChunk = {
  type?: 'local-tool-request';
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
};

function createClientSessionId(): string {
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clearScreen(): void {
  output.write('\x1b[2J\x1b[H');
}

function formatSession(session: CliSession, selected: boolean): string {
  const marker = selected ? '>' : ' ';
  const title = session.title?.trim() || 'Untitled';
  const model = session.model ?? 'default';
  return `${marker} ${title}  [${model}]  ${session.id.slice(0, 8)}`;
}

function formatModel(model: CliModel, selected: boolean): string {
  const marker = selected ? '>' : ' ';
  const limits = [
    model.contextLimit ? `ctx ${model.contextLimit}` : null,
    model.maxOutputTokens ? `out ${model.maxOutputTokens}` : null,
    model.temperature !== undefined ? `temp ${model.temperature}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${marker} ${model.id}${limits ? `  (${limits})` : ''}`;
}

async function prompt(rl: ReturnType<typeof createInterface>, label: string) {
  return (await rl.question(label)).trim();
}

async function loadState(): Promise<TuiState> {
  const stored = readJson<CliConfig>(CLI_CONFIG_FILE);
  const baseUrl =
    stored?.url?.trim() ?? process.env.AGENTBOSTER_URL?.trim() ?? '';
  if (!baseUrl) {
    throw new Error(
      'Missing CLI URL. Run `agentboster login --url ...` first.',
    );
  }

  const api = createApiClient(baseUrl, stored?.token);
  const [modelsResult, sessionsResult] = await Promise.all([
    api.listModels(),
    api.listSessions(),
  ]);
  const currentSessionId = sessionsResult.sessions[0]?.id ?? null;
  const currentMessages = currentSessionId
    ? (await api.getSessionMessages(currentSessionId)).messages
    : [];

  return {
    baseUrl,
    token: stored?.token,
    models: modelsResult.models,
    defaultModel: modelsResult.defaultModel,
    sessions: sessionsResult.sessions,
    currentSessionId,
    currentMessages,
  };
}

async function loadStateWithFallback(): Promise<TuiState> {
  try {
    return await loadState();
  } catch (error) {
    const stored = readJson<CliConfig>(CLI_CONFIG_FILE);
    const baseUrl =
      stored?.url?.trim() ?? process.env.AGENTBOSTER_URL?.trim() ?? '';
    if (!baseUrl) {
      throw error;
    }

    return {
      baseUrl,
      token: stored?.token,
      models: [],
      defaultModel: null,
      sessions: [],
      currentSessionId: null,
      currentMessages: [],
    };
  }
}

function render(state: TuiState, messageLines: string[] = []): void {
  clearScreen();
  const currentSession = state.sessions.find(
    (item) => item.id === state.currentSessionId,
  );

  output.write('agentboster\n');
  output.write(`url: ${state.baseUrl}\n`);
  output.write(
    `session: ${currentSession?.title?.trim() || currentSession?.id || '(new)'}\n`,
  );
  output.write(
    `model: ${currentSession?.model ?? state.defaultModel ?? 'free-form'}\n`,
  );
  output.write('\nChat\n');
  if (state.currentMessages.length === 0) {
    output.write('  (no messages yet)\n');
  }
  for (const message of state.currentMessages.slice(-10)) {
    output.write(`  ${message.role}> ${message.content}\n`);
  }
  output.write('\nSessions\n');
  for (const session of state.sessions.slice(0, 8)) {
    output.write(
      `${formatSession(session, session.id === state.currentSessionId)}\n`,
    );
  }
  output.write('\nModels\n');
  for (const model of state.models.slice(0, 8)) {
    output.write(
      `${formatModel(model, model.id === (currentSession?.model ?? state.defaultModel))}\n`,
    );
  }
  output.write('\n');
  for (const line of messageLines.slice(-8)) {
    output.write(`${line}\n`);
  }
  output.write(
    '\nCommands: /login /pair /sessions /models /new /use <n|id> /model <id> /send <text> /refresh /quit\n',
  );
}

async function confirm(label: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${label} [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function authorizeLocalCommand(command: string): Promise<boolean> {
  const decision = await evaluateLocalCommand(command);
  if (decision.level === 'l0' && decision.ok) {
    return true;
  }

  const l1Text = decision.reasoning
    ? `L1: ${decision.reasoning} (${decision.score ?? 0})`
    : 'L1 review required';
  const approvedL1 = await confirm(`L0 passed. ${l1Text}. Continue?`);
  if (!approvedL1) {
    return false;
  }

  if (decision.level === 'l2' || decision.ok === false) {
    return confirm('L2 approval required for risky local command. Approve?');
  }

  return true;
}

async function handleLocalToolRequest(input: {
  api: ReturnType<typeof createApiClient>;
  runId: string;
  chunk: LocalToolChunk;
}): Promise<LocalHistoryEntry> {
  if (!input.chunk.toolCallId || !input.chunk.toolName) {
    return { kind: 'error', text: 'invalid local tool request' };
  }

  const commandPreview = `${input.chunk.toolName} ${JSON.stringify(input.chunk.toolInput ?? {})}`;
  const approved = await authorizeLocalCommand(commandPreview);
  if (!approved) {
    const result: LocalToolResultPayload = {
      ok: false,
      error: 'Denied by user',
    };
    await input.api.postLocalToolResult({
      runId: input.runId,
      toolCallId: input.chunk.toolCallId,
      result,
    });
    return { kind: 'error', text: `blocked ${input.chunk.toolName}` };
  }

  const result = await executeLocalTool(
    input.chunk.toolName,
    input.chunk.toolInput,
  );
  await input.api.postLocalToolResult({
    runId: input.runId,
    toolCallId: input.chunk.toolCallId,
    result,
  });
  return {
    kind: 'tool',
    text: `${input.chunk.toolName}: ${result.ok ? 'ok' : 'failed'}`,
  };
}

async function sendMessage(
  state: TuiState,
  text: string,
  model?: string | null,
): Promise<string[]> {
  const api = createApiClient(state.baseUrl, state.token);
  const sessionId = state.currentSessionId ?? createClientSessionId();
  state.currentSessionId = sessionId;
  const response = await api.sendMessage({
    sessionId,
    message: text,
    model,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const entries: LocalHistoryEntry[] = [{ kind: 'info', text: `you> ${text}` }];
  let lastAssistant = '';
  const runId = response.headers.get('x-workflow-run-id') ?? '';

  for await (const chunk of readUiMessageStream(response)) {
    if (chunk.type === 'data-workflow') {
      const data = chunk.data as LocalToolChunk;
      if (data?.type === 'local-tool-request' && runId) {
        const entry = await handleLocalToolRequest({
          api,
          runId,
          chunk: data,
        });
        entries.push(entry);
      }
    }

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      lastAssistant += chunk.text;
    }
  }

  if (lastAssistant) {
    entries.push({ kind: 'info', text: `assistant> ${lastAssistant}` });
  }

  return entries.map((entry) => `${entry.kind}> ${entry.text}`);
}

async function refresh(state: TuiState): Promise<void> {
  const api = createApiClient(state.baseUrl, state.token);
  const [modelsResult, sessionsResult] = await Promise.all([
    api.listModels(),
    api.listSessions(),
  ]);
  state.models = modelsResult.models;
  state.defaultModel = modelsResult.defaultModel;
  state.sessions = sessionsResult.sessions;
  if (!state.currentSessionId && state.sessions[0]) {
    state.currentSessionId = state.sessions[0].id;
  }
  if (state.currentSessionId) {
    const current = state.sessions.find(
      (item) => item.id === state.currentSessionId,
    );
    if (current) {
      const currentMessages = await api.getSessionMessages(current.id);
      state.currentMessages = currentMessages.messages;
    }
  } else {
    state.currentMessages = [];
  }
}

async function chooseSession(state: TuiState, value: string): Promise<void> {
  const index = Number(value);
  if (Number.isInteger(index) && index > 0 && index <= state.sessions.length) {
    state.currentSessionId = state.sessions[index - 1].id;
    return;
  }

  const session = state.sessions.find((item) => item.id.startsWith(value));
  if (session) {
    state.currentSessionId = session.id;
    const api = createApiClient(state.baseUrl, state.token);
    const detail = await api.getSessionMessages(session.id);
    state.currentMessages = detail.messages;
    return;
  }

  throw new Error(`Unknown session: ${value}`);
}

async function changeSessionModel(
  state: TuiState,
  modelId: string,
): Promise<void> {
  const sessionId = state.currentSessionId;
  if (!sessionId) {
    throw new Error('No active session to update.');
  }

  const api = createApiClient(state.baseUrl, state.token);
  const current = state.sessions.find((item) => item.id === sessionId);
  await api.updateSessionModel(sessionId, modelId || null);
  if (current) {
    current.model = modelId || null;
  }
}

function activeModelId(state: TuiState): string | null {
  const currentSession = state.sessions.find(
    (item) => item.id === state.currentSessionId,
  );
  return currentSession?.model ?? state.defaultModel;
}

async function startNewSession(state: TuiState): Promise<void> {
  state.currentSessionId = createClientSessionId();
  state.currentMessages = [];
}

export async function runCliTui(): Promise<void> {
  let state = await loadStateWithFallback();
  const rl = createInterface({ input, output });
  const transcript: string[] = [];

  try {
    while (true) {
      render(state, transcript);
      const command = await prompt(rl, '> ');

      if (!command) {
        continue;
      }

      if (command === '/quit' || command === '/exit') {
        return;
      }

      if (command === '/refresh') {
        await refresh(state);
        transcript.push('refreshed');
        continue;
      }

      if (command === '/new') {
        await startNewSession(state);
        transcript.push('new session');
        continue;
      }

      if (command === '/login') {
        const url = await prompt(rl, 'url: ');
        const username = await prompt(rl, 'username: ');
        const password = await prompt(rl, 'password: ');
        await loginCommand({ url, username, password });
        state = await loadState();
        transcript.push(`logged in as ${username}`);
        continue;
      }

      if (command === '/pair') {
        await pairCommand({ url: state.baseUrl, adapter: 'slack' });
        transcript.push('pair code generated');
        continue;
      }

      if (command === '/sessions') {
        await refresh(state);
        transcript.push(
          ...state.sessions
            .slice(0, 8)
            .map(
              (session, index) =>
                `${index + 1}. ${session.title?.trim() || 'Untitled'}`,
            ),
        );
        continue;
      }

      if (command === '/models') {
        await refresh(state);
        transcript.push(
          ...state.models
            .slice(0, 8)
            .map((model, index) => `${index + 1}. ${model.id}`),
        );
        continue;
      }

      if (command.startsWith('/use ')) {
        await chooseSession(state, command.slice('/use '.length).trim());
        transcript.push(`switched to ${state.currentSessionId}`);
        continue;
      }

      if (command.startsWith('/model ')) {
        await changeSessionModel(state, command.slice('/model '.length).trim());
        transcript.push(
          `updated model to ${command.slice('/model '.length).trim()}`,
        );
        continue;
      }

      if (command.startsWith('/send ')) {
        const lines = await sendMessage(
          state,
          command.slice('/send '.length).trim(),
          activeModelId(state),
        );
        transcript.push(...lines);
        await refresh(state);
        continue;
      }

      const lines = await sendMessage(state, command, activeModelId(state));
      transcript.push(...lines);
      await refresh(state);
    }
  } finally {
    rl.close();
  }
}
