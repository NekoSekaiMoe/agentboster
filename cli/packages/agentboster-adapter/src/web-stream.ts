/**
 * Web stream adapter.
 *
 * Converts the Agentboster web backend's SSE (Vercel AI SDK UI message
 * stream protocol) into a pi `AssistantMessageEventStream`.
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ToolCall,
} from '@agentboster-cli/ai';
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@agentboster-cli/ai/utils/event-stream';

export type WebStreamChunk = {
  type: string;
  [key: string]: unknown;
};

export type LocalToolRequestHandler = (input: {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}) => Promise<void>;

export type SubagentEventHandler = (input: {
  subagentId: string;
  subagentName: string;
  event: 'started' | 'completed' | 'failed';
  task: string;
  summary?: string;
  error?: string;
  steps?: number;
  modelId?: string;
}) => void;

export type SubagentBatchEventHandler = (input: {
  batchId: string;
  event: 'spawned' | 'completed' | 'cancelled';
  concurrencyLimit: number;
  total: number;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  summary?: string;
}) => void;

export interface WebStreamOptions {
  baseUrl: string;
  token: string;
  sessionId: string;
  clientId: string;
  label?: string;
  model?: string | null;
  onLocalToolRequest?: LocalToolRequestHandler;
  onSubagentEvent?: SubagentEventHandler;
  onSubagentBatchEvent?: SubagentBatchEventHandler;
  /** Abort signal from pi's agent loop. When aborted, the fetch is cancelled. */
  signal?: AbortSignal;
  /** When set, POST with `trigger: 'regenerate-message'` and this messageId
   *  instead of `submit-message`. Used by the tree-selector edit-and-resend
   *  flow to ask the backend to truncate + rerun from the given message. */
  regenerate?: {
    messageId: string;
    metadata?: unknown;
  };
  /** Merged AGENTS.md content from the CLI host's local filesystem. Sent
   *  on the first user message of a session so the Web backend can inject
   *  it into the system prompt as project-supplied reference data. The
   *  backend gates this on `source.type === 'cli'` and ignores it for
   *  web/IM sources. */
  agentsMd?: string;
}

function lastUserText(messages: Context['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const texts: string[] = [];
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            texts.push(part.text);
          }
        }
        return texts.join('\n');
      }
    }
  }
  return '';
}

function emptyAssistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses' as Api,
    provider: 'agentboster' as never,
    model: 'agentboster',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function errorMessage(text: string): AssistantMessage {
  const msg = emptyAssistant();
  msg.content = [{ type: 'text', text }];
  msg.stopReason = 'error';
  msg.errorMessage = text;
  return msg;
}

export function openAgentbosterStream(
  _model: Model<Api>,
  context: Context,
  options: WebStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void driveStream(stream, context, options).catch((err) => {
    const text = err instanceof Error ? err.message : String(err);
    stream.push({ type: 'error', reason: 'error', error: errorMessage(text) });
  });
  return stream;
}

interface StreamState {
  partial: AssistantMessage;
  textIndex: number;
  thinkingIndex: number;
  toolIndex: number;
  started: boolean;
}

function newState(): StreamState {
  return {
    partial: emptyAssistant(),
    textIndex: -1,
    thinkingIndex: -1,
    toolIndex: -1,
    started: false,
  };
}

function emitStart(
  stream: AssistantMessageEventStream,
  state: StreamState,
): void {
  if (state.started) return;
  state.started = true;
  stream.push({ type: 'start', partial: state.partial });
}

async function driveStream(
  stream: AssistantMessageEventStream,
  context: Context,
  options: WebStreamOptions,
): Promise<void> {
  const text = lastUserText(context.messages);
  const root = options.baseUrl.replace(/\/$/, '');

  const response = await fetch(`${root}/api/cli/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
      cookie: `clawless-auth=${options.token}`,
    },
    body: JSON.stringify({
      id: options.sessionId,
      trigger: options.regenerate ? 'regenerate-message' : 'submit-message',
      ...(options.regenerate
        ? { messageId: options.regenerate.messageId }
        : {}),
      input: {
        parts: [{ type: 'text', text }],
        text,
        ...(options.regenerate?.metadata
          ? { metadata: options.regenerate.metadata }
          : {}),
      },
      clientId: options.clientId,
      label: options.label ?? 'agentboster-cli',
      model: options.model ?? undefined,
      ...(options.agentsMd ? { agentsMd: options.agentsMd } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    stream.push({
      type: 'error',
      reason: 'error',
      error: errorMessage(
        `HTTP ${response.status}: ${body || response.statusText}`,
      ),
    });
    return;
  }

  const runId = response.headers.get('x-workflow-run-id') ?? '';
  const state = newState();

  try {
    for await (const chunk of readSse(response)) {
      if (handleChunk(stream, state, chunk, runId, options)) {
        return;
      }
    }
    // Synthesize a done if the stream ended without one.
    finalize(stream, state, 'stop');
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    stream.push({
      type: 'error',
      reason: 'error',
      error: errorMessage(`Stream read error: ${text}`),
    });
  }
}

function handleChunk(
  stream: AssistantMessageEventStream,
  state: StreamState,
  chunk: WebStreamChunk,
  runId: string,
  options: WebStreamOptions,
): boolean {
  switch (chunk.type) {
    case 'text-start':
      emitStart(stream, state);
      state.textIndex = state.partial.content.length;
      state.partial.content.push({ type: 'text', text: '' });
      stream.push({
        type: 'text_start',
        contentIndex: state.textIndex,
        partial: state.partial,
      });
      return false;

    case 'text-delta': {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
      if (state.textIndex < 0) {
        emitStart(stream, state);
        state.textIndex = state.partial.content.length;
        state.partial.content.push({ type: 'text', text: '' });
        stream.push({
          type: 'text_start',
          contentIndex: state.textIndex,
          partial: state.partial,
        });
      }
      const part = state.partial.content[state.textIndex];
      if (part && part.type === 'text') {
        part.text += delta;
      }
      stream.push({
        type: 'text_delta',
        contentIndex: state.textIndex,
        delta,
        partial: state.partial,
      });
      return false;
    }

    case 'text-end': {
      if (state.textIndex < 0) return false;
      const part = state.partial.content[state.textIndex];
      const content = part && part.type === 'text' ? part.text : '';
      stream.push({
        type: 'text_end',
        contentIndex: state.textIndex,
        content,
        partial: state.partial,
      });
      state.textIndex = -1;
      return false;
    }

    case 'reasoning-start':
      emitStart(stream, state);
      state.thinkingIndex = state.partial.content.length;
      state.partial.content.push({ type: 'thinking', thinking: '' });
      stream.push({
        type: 'thinking_start',
        contentIndex: state.thinkingIndex,
        partial: state.partial,
      });
      return false;

    case 'reasoning-delta': {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
      if (state.thinkingIndex >= 0) {
        const part = state.partial.content[state.thinkingIndex];
        if (part && part.type === 'thinking') {
          part.thinking += delta;
        }
        stream.push({
          type: 'thinking_delta',
          contentIndex: state.thinkingIndex,
          delta,
          partial: state.partial,
        });
      }
      return false;
    }

    case 'reasoning-end': {
      if (state.thinkingIndex < 0) return false;
      const part = state.partial.content[state.thinkingIndex];
      const content = part && part.type === 'thinking' ? part.thinking : '';
      stream.push({
        type: 'thinking_end',
        contentIndex: state.thinkingIndex,
        content,
        partial: state.partial,
      });
      state.thinkingIndex = -1;
      return false;
    }

    case 'tool-input-start': {
      emitStart(stream, state);
      state.toolIndex = state.partial.content.length;
      const id = typeof chunk.id === 'string' ? chunk.id : '';
      const name = typeof chunk.toolName === 'string' ? chunk.toolName : '';
      const toolCall: ToolCall = {
        type: 'toolCall',
        id,
        name,
        arguments: {},
      };
      state.partial.content.push(toolCall);
      stream.push({
        type: 'toolcall_start',
        contentIndex: state.toolIndex,
        partial: state.partial,
      });
      return false;
    }

    case 'tool-input-delta': {
      const delta =
        typeof chunk.inputTextDelta === 'string' ? chunk.inputTextDelta : '';
      if (state.toolIndex >= 0) {
        const part = state.partial.content[state.toolIndex];
        if (part && part.type === 'toolCall') {
          const accum = (part as unknown as { _raw?: string })._raw ?? '';
          (part as unknown as { _raw?: string })._raw = accum + delta;
        }
      }
      stream.push({
        type: 'toolcall_delta',
        contentIndex: state.toolIndex,
        delta,
        partial: state.partial,
      });
      return false;
    }

    case 'tool-input-end': {
      if (state.toolIndex < 0) return false;
      const part = state.partial.content[state.toolIndex];
      if (part && part.type === 'toolCall') {
        const raw = (part as unknown as { _raw?: string })._raw;
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            part.arguments = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // leave arguments as {} on parse failure
          }
          delete (part as unknown as { _raw?: string })._raw;
        }
      }
      stream.push({
        type: 'toolcall_end',
        contentIndex: state.toolIndex,
        toolCall:
          part && part.type === 'toolCall'
            ? part
            : ({
                type: 'toolCall',
                id: '',
                name: '',
                arguments: {},
              } as ToolCall),
        partial: state.partial,
      });
      state.toolIndex = -1;
      return false;
    }

    case 'tool-result':
      // Server-side tool execution results are absorbed by the server
      // into conversation history; nothing to emit to the agent loop.
      return false;

    case 'data-workflow': {
      const data = chunk.data as { type?: string; kind?: string } | undefined;
      if (data?.type === 'local-tool-request') {
        const detail = data as {
          toolCallId?: string;
          toolName?: string;
          toolInput?: unknown;
        };
        if (
          options.onLocalToolRequest &&
          typeof detail.toolCallId === 'string' &&
          typeof detail.toolName === 'string' &&
          runId
        ) {
          void options.onLocalToolRequest({
            runId,
            toolCallId: detail.toolCallId,
            toolName: detail.toolName,
            toolInput: detail.toolInput,
          });
        }
      }
      if (data?.type === 'subagent-event' && options.onSubagentEvent) {
        const detail = data as {
          subagentId?: string;
          subagentName?: string;
          event?: 'started' | 'completed' | 'failed';
          task?: string;
          summary?: string;
          error?: string;
          steps?: number;
          modelId?: string;
        };
        if (
          typeof detail.subagentId === 'string' &&
          typeof detail.subagentName === 'string' &&
          (detail.event === 'started' ||
            detail.event === 'completed' ||
            detail.event === 'failed') &&
          typeof detail.task === 'string'
        ) {
          options.onSubagentEvent({
            subagentId: detail.subagentId,
            subagentName: detail.subagentName,
            event: detail.event,
            task: detail.task,
            summary:
              typeof detail.summary === 'string' ? detail.summary : undefined,
            error: typeof detail.error === 'string' ? detail.error : undefined,
            steps: typeof detail.steps === 'number' ? detail.steps : undefined,
            modelId:
              typeof detail.modelId === 'string' ? detail.modelId : undefined,
          });
        }
      }
      if (
        data?.type === 'subagent-batch-event' &&
        options.onSubagentBatchEvent
      ) {
        const detail = data as {
          batchId?: string;
          event?: 'spawned' | 'completed' | 'cancelled';
          concurrencyLimit?: number;
          total?: number;
          succeeded?: number;
          failed?: number;
          cancelled?: number;
          summary?: string;
        };
        if (
          typeof detail.batchId === 'string' &&
          (detail.event === 'spawned' ||
            detail.event === 'completed' ||
            detail.event === 'cancelled') &&
          typeof detail.concurrencyLimit === 'number' &&
          typeof detail.total === 'number'
        ) {
          options.onSubagentBatchEvent({
            batchId: detail.batchId,
            event: detail.event,
            concurrencyLimit: detail.concurrencyLimit,
            total: detail.total,
            succeeded:
              typeof detail.succeeded === 'number'
                ? detail.succeeded
                : undefined,
            failed:
              typeof detail.failed === 'number' ? detail.failed : undefined,
            cancelled:
              typeof detail.cancelled === 'number'
                ? detail.cancelled
                : undefined,
            summary:
              typeof detail.summary === 'string' ? detail.summary : undefined,
          });
        }
      }
      // Update usage stats from token-usage chunks.
      if (data?.type === 'token-usage' || data?.kind === 'status') {
        const usage = (data as { usage?: Record<string, number> }).usage;
        if (usage) {
          const input = usage.input ?? usage.promptTokens ?? 0;
          const output = usage.output ?? usage.completionTokens ?? 0;
          const cacheRead = usage.cacheRead ?? 0;
          const cacheWrite = usage.cacheWrite ?? 0;
          // Web may send cost as a number (legacy) or as an
          // object matching pi-ai's Usage.cost shape. Normalize.
          const rawCost = usage.cost;
          const costNum = typeof rawCost === 'number' ? rawCost : 0;
          const costObj =
            typeof rawCost === 'object' && rawCost !== null
              ? {
                  input: (rawCost as Record<string, number>).input ?? 0,
                  output: (rawCost as Record<string, number>).output ?? 0,
                  cacheRead: (rawCost as Record<string, number>).cacheRead ?? 0,
                  cacheWrite:
                    (rawCost as Record<string, number>).cacheWrite ?? 0,
                  total: (rawCost as Record<string, number>).total ?? costNum,
                }
              : {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: costNum,
                };
          state.partial.usage = {
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens: usage.totalTokens,
            cost: costObj,
          };
        }
      }
      return false;
    }

    case 'error': {
      const message =
        typeof chunk.message === 'string' ? chunk.message : 'unknown error';
      stream.push({
        type: 'error',
        reason: 'error',
        error: errorMessage(message),
      });
      return true;
    }

    case 'finish':
      return finalize(stream, state, mapFinishReason(chunk.finishReason));

    case 'done':
      return finalize(stream, state, 'stop');

    default:
      return false;
  }
}

function mapFinishReason(reason: unknown): 'stop' | 'length' | 'toolUse' {
  if (reason === 'length') return 'length';
  // Tool calls are executed on the web backend (local_* tools via the
  // CLI's local-tool-request handler, all other tools by the workflow
  // runtime). The CLI's own pi-agent loop has no tool registry for
  // these names, so reporting "toolUse" would make it try to dispatch
  // them locally and fail with "Tool <name> not found". Map toolUse
  // to "stop" so the agent loop ends the turn cleanly; the web SSE
  // stream keeps pushing subsequent assistant messages (one per
  // backend-side loop iteration) as separate turns.
  if (reason === 'tool-calls' || reason === 'toolUse') return 'stop';
  return 'stop';
}

function finalize(
  stream: AssistantMessageEventStream,
  state: StreamState,
  reason: 'stop' | 'length' | 'toolUse',
): boolean {
  state.partial.stopReason = reason;
  stream.push({ type: 'done', reason, message: state.partial });
  return true;
}

async function* readSse(response: Response): AsyncGenerator<WebStreamChunk> {
  if (!response.body) throw new Error('Response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frameEnd = buffer.indexOf('\n\n');
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const chunk = parseFrame(frame);
        if (chunk) yield chunk;
        frameEnd = buffer.indexOf('\n\n');
      }
    }
    const remaining = buffer.trim();
    if (remaining) {
      const chunk = parseFrame(remaining);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): WebStreamChunk | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return { type: 'done' };
  try {
    return JSON.parse(raw) as WebStreamChunk;
  } catch {
    return null;
  }
}
