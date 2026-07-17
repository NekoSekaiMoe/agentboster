import type { AdapterName } from '@/types/config/channels';
import { botLocaleSchema, type BotLocale } from '@/types/config/language';
import type { UIMessage, UIMessageChunk } from 'ai';
import { z } from 'zod';

const tokenUsageBucketSchema = z.union([
  z.number(),
  z.object({
    total: z.number().optional(),
    noCache: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    text: z.number().optional(),
    reasoning: z.number().optional(),
  }),
]);

/** A single message part — text or file. Shared across all message versions. */
export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'file';
      filename?: string;
      mediaType: string;
      url: string;
      providerMetadata?: unknown;
    };

/**
 * A versioned snapshot of a message.
 *
 * Every message (user or assistant) carries an optional `versions` array:
 * each entry is one historical version of that message's content. The
 * currently-displayed version is `versions[currentVersionIndex]`.
 *
 * For user messages, `response` optionally holds the assistant reply that
 * was produced when this user version was last sent. This preserves the
 * edit → regenerate pairing for older conversations where the assistant
 * rows have since been truncated from the DB. Assistant messages do not
 * use `response`.
 */
export interface MessageVersion {
  parts: MessagePart[];
  createdAt: string;
  response?: MessagePart[];
}

export type ChatMessageMetadata = {
  stepNumber?: number;
  finishReason?: string;
  createdAt?: string;
  toolName?: string;
  agentName?: string;
  /** Versioned snapshots of this message. Unified across user/assistant roles. */
  versions?: MessageVersion[];
  /** Index into `versions` of the currently-displayed version. */
  currentVersionIndex?: number;
};

const messagePartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('file'),
    filename: z.string().optional(),
    mediaType: z.string(),
    url: z.string(),
    providerMetadata: z.unknown().optional(),
  }),
]);

export const messageVersionSchema = z.object({
  parts: z.array(messagePartSchema),
  createdAt: z.string(),
  response: z.array(messagePartSchema).optional(),
});

export const chatMessageMetadataSchema = z.object({
  stepNumber: z.number().finite().optional(),
  finishReason: z.string().optional(),
  createdAt: z.string().optional(),
  toolName: z.string().optional(),
  agentName: z.string().optional(),
  versions: z.array(messageVersionSchema).optional(),
  currentVersionIndex: z.number().finite().optional(),
});

const tokenUsageSchema = z.object({
  inputTokens: tokenUsageBucketSchema.optional(),
  outputTokens: tokenUsageBucketSchema.optional(),
  totalTokens: z.number().optional(),
});

export const runtimeEventPayloadSchema = z.object({
  event: z.enum([
    'sandbox-created',
    'sandbox-reused',
    'sandbox-command-start',
    'sandbox-command-finish',
    'sandbox-command-running',
    'sandbox-port-url',
    'sandbox-export-start',
    'sandbox-export-finish',
    'sandbox-export-failed',
    'sandbox-stopped',
    'workflow-cancelled',
    'runtime-error',
  ]),
  sessionId: z.string(),
  runId: z.string().nullable().optional(),
  sandboxId: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});

export type RuntimeEventPayload = z.infer<typeof runtimeEventPayloadSchema>;

export const workflowMessageDataSchema = z.discriminatedUnion('type', [
  z.object({
    kind: z.literal('message'),
    type: z.literal('system-event'),
    agentName: z.string().optional(),
    eventType: z.string(),
    message: z.string(),
  }),
]);

export const workflowStatusDataSchema = z.discriminatedUnion('type', [
  z.object({
    kind: z.literal('status'),
    type: z.literal('runtime-event'),
    agentName: z.string().optional(),
    payload: runtimeEventPayloadSchema,
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('token-usage'),
    agentName: z.string().optional(),
    usage: tokenUsageSchema,
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('step-finish'),
    agentName: z.string().optional(),
    stepNumber: z.number().finite(),
    finishReason: z.string(),
    totalTokens: z.number().finite(),
    inputTokens: tokenUsageBucketSchema.optional(),
    outputTokens: tokenUsageBucketSchema.optional(),
    messageIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('user-message'),
    agentName: z.string().optional(),
    content: z.string(),
    uiMessageId: z.string().nullable().optional(),
    internal: z.literal(true),
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('local-tool-request'),
    agentName: z.string().optional(),
    /**
     * The toolCallId the LLM emitted. The CLI uses this as the hook
     * resume token when POSTing the result back to
     * /api/ai/[runId]/tool-result.
     */
    toolCallId: z.string(),
    /** Tool name as the model emitted it (e.g. "local_read_file"). */
    toolName: z.string(),
    /** The validated input object the model passed to the tool. */
    toolInput: z.unknown(),
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('subagent-event'),
    agentName: z.string().optional(),
    subagentId: z.string(),
    subagentName: z.string(),
    event: z.enum(['started', 'completed', 'failed']),
    task: z.string(),
    summary: z.string().optional(),
    error: z.string().optional(),
    steps: z.number().finite().optional(),
    modelId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('status'),
    type: z.literal('subagent-batch-event'),
    agentName: z.string().optional(),
    batchId: z.string(),
    event: z.enum(['spawned', 'completed', 'cancelled']),
    concurrencyLimit: z.number().finite(),
    total: z.number().finite(),
    succeeded: z.number().finite().optional(),
    failed: z.number().finite().optional(),
    cancelled: z.number().finite().optional(),
    summary: z.string().optional(),
  }),
]);

export const workflowDataSchema = z.discriminatedUnion('kind', [
  workflowMessageDataSchema,
  workflowStatusDataSchema,
]);

export type WorkflowMessageData = z.infer<typeof workflowMessageDataSchema>;
export type WorkflowStatusData = z.infer<typeof workflowStatusDataSchema>;
export type WorkflowDataPart = z.infer<typeof workflowDataSchema>;

export type WorkflowUIDataParts = {
  workflow: WorkflowDataPart;
};

export type WorkflowUIMessage = UIMessage<
  ChatMessageMetadata,
  WorkflowUIDataParts
>;

export type WorkflowUIMessageChunk = UIMessageChunk<
  ChatMessageMetadata,
  WorkflowUIDataParts
>;

export type WorkflowUIPart = WorkflowUIMessage['parts'][number];
export type WorkflowDataUIPart = Extract<
  WorkflowUIPart,
  { type: 'data-workflow' }
>;
export type WorkflowMessageUIPart = WorkflowDataUIPart & {
  data: WorkflowMessageData;
};
export type WorkflowStatusUIPart = WorkflowDataUIPart & {
  data: WorkflowStatusData;
};

export type UserMessagePart = Extract<
  WorkflowUIPart,
  { type: 'text' | 'file' }
>;

export function isWorkflowDataUIPart(
  part: WorkflowUIPart,
): part is WorkflowDataUIPart {
  return part.type === 'data-workflow';
}

export function isWorkflowMessageUIPart(
  part: WorkflowUIPart,
): part is WorkflowMessageUIPart {
  return isWorkflowDataUIPart(part) && part.data.kind === 'message';
}

export function isWorkflowStatusUIPart(
  part: WorkflowUIPart,
): part is WorkflowStatusUIPart {
  return isWorkflowDataUIPart(part) && part.data.kind === 'status';
}

export function getWorkflowDataAgentName(
  part: WorkflowDataUIPart,
): string | undefined {
  return typeof part.data.agentName === 'string' &&
    part.data.agentName.trim().length > 0
    ? part.data.agentName
    : undefined;
}

export const COMMANDS = [
  'help',
  'status',
  'new',
  'init',
  'approve',
  'reject',
  'sessions',
  'session',
  'switch',
  'delete_session',
  'stop',
  'compact',
  'decisions',
  'model',
  'provider',
  'config',
  'memory',
  'pair',
  'unpair',
  'whoami',
  'start',
  'cancel',
  'reset',
  'retry',
  'version',
  'id',
  'lang',
  'attach',
  'detach',
  'remote',
] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommandName(value: string): value is Command {
  return COMMANDS.includes(value as Command);
}

export type SessionStatus = 'active' | 'completed' | 'stopped' | 'error';

export type PersistedMessageRole =
  | 'user'
  | 'assistant'
  | 'summary'
  | 'tool'
  | 'system';

export type WebChatSource = {
  type: 'web';
  userId?: string | null;
};

export type ScheduledChatSource = {
  type: 'scheduled';
};

export type IMChatSource = {
  type: 'im';
  adapter: AdapterName;
  origin: string;
  threadId: string;
  messageId?: string | null;
  /**
   * Resolved ClawLess user id when a pairing exists; otherwise the raw
   * IM-platform id. Session, task, memory, and L2 scoping use this field
   * for multi-tenant isolation.
   */
  userId?: string | null;
  /**
   * Always the raw IM-platform id, even after a ClawLess user has been
   * resolved. Commands that key off the IM account (e.g. /whoami, /unpair,
   * /pair) must read this field, not {@link userId}.
   */
  rawImUserId?: string | null;
  userName?: string | null;
  locale?: BotLocale;
  /**
   * True when this IM message was routed to a CLI session via /attach.
   * Used by tool registration (enables local_* and computer-use tools)
   * and L2 approval flow (routes approval to IM instead of CLI TUI).
   */
  remoteIm?: boolean;
  /**
   * IM adapter name when remoteIm is true (e.g., 'telegram', 'discord').
   */
  remoteAdapter?: AdapterName;
  /**
   * IM thread ID when remoteIm is true.
   */
  remoteThreadId?: string;
};

/**
 * Source emitted by the agentboster CLI client. Each CLI installation has
 * a stable `clientId` (typically a machine-id-derived UUID generated on
 * first run and stored under `~/.agentboster/cli.json`). The session
 * channel for CLI-originated sessions is `cli:<clientId>`, which keeps
 * cross-machine CLI sessions isolated from each other (a CLI session
 * started on laptop-A cannot be continued from laptop-B).
 *
 * `local_*` file/exec tools are only registered when the source is `cli`,
 * because only the CLI host actually has the user's filesystem.
 */
export type CLIChatSource = {
  type: 'cli';
  /**
   * Resolved ClawLess user id. Always present after pairing / login,
   * since CLI sessions require authentication against the web app.
   */
  userId?: string | null;
  /**
   * Stable per-machine identifier. Two CLI processes on the same host
   * share the same clientId and therefore can continue each other's
   * sessions; a CLI on a different host cannot.
   */
  clientId: string;
  /**
   * Best-effort human-readable label for logging/UI (hostname, OS, etc.).
   * Not used for security decisions.
   */
  label?: string | null;
};

export type ChatSource =
  | WebChatSource
  | ScheduledChatSource
  | IMChatSource
  | CLIChatSource;

const adapterNameSchema = z.custom<AdapterName>(
  (value): value is AdapterName => typeof value === 'string',
);

const webChatSourceSchema = z.object({
  type: z.literal('web'),
});

const scheduledChatSourceSchema = z.object({
  type: z.literal('scheduled'),
});

const imChatSourceSchema = z.object({
  type: z.literal('im'),
  adapter: adapterNameSchema,
  origin: z.string(),
  threadId: z.string(),
  messageId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  userName: z.string().nullable().optional(),
  locale: botLocaleSchema.optional(),
  remoteIm: z.boolean().optional(),
  remoteAdapter: adapterNameSchema.optional(),
  remoteThreadId: z.string().optional(),
});

const cliChatSourceSchema = z.object({
  type: z.literal('cli'),
  userId: z.string().nullable().optional(),
  clientId: z.string().min(1),
  label: z.string().nullable().optional(),
});

export const chatSourceSchema = z.discriminatedUnion('type', [
  webChatSourceSchema,
  scheduledChatSourceSchema,
  imChatSourceSchema,
  cliChatSourceSchema,
]);

export function parseChatSource(value: unknown): ChatSource | null {
  const parsed = chatSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isImChatSource(value: unknown): value is IMChatSource {
  return imChatSourceSchema.safeParse(value).success;
}

export function isCliChatSource(value: unknown): value is CLIChatSource {
  return cliChatSourceSchema.safeParse(value).success;
}

export function getChatSourceFromSessionMetadata(
  metadata: unknown,
): ChatSource | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const source = (metadata as { source?: unknown }).source;
  return parseChatSource(source);
}

export type MessageInputEnvelope = {
  kind: 'message';
  sessionId?: string;
  uiMessageId?: string;
  text: string;
  parts: UserMessagePart[];
  source: ChatSource;
};

export type CommandInputEnvelope = {
  kind: 'command';
  sessionId?: string;
  uiMessageId?: string;
  command: Command;
  args: string;
  text: string;
  parts: UserMessagePart[];
  source: ChatSource;
};

export type ChatInputEnvelope = MessageInputEnvelope | CommandInputEnvelope;

export function buildExternalThreadId(source: ChatSource): string | null {
  if (source.type !== 'im') {
    return null;
  }

  return `${source.adapter}:${source.origin}:${source.threadId}`;
}

export function normalizeMessageText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function extractTextFromParts(parts: UserMessagePart[]): string {
  return normalizeMessageText(
    parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
  );
}

export function parseChatInputEnvelope(input: {
  sessionId?: string;
  uiMessageId?: string;
  parts?: UserMessagePart[];
  text?: string;
  source: ChatSource;
}): ChatInputEnvelope {
  const parts = input.parts ?? [];
  const text = normalizeMessageText(input.text ?? extractTextFromParts(parts));

  if (text.startsWith('/')) {
    const [rawCommand = '', ...rest] = text.slice(1).split(/\s+/);
    if (isCommandName(rawCommand)) {
      return {
        kind: 'command',
        sessionId: input.sessionId,
        uiMessageId: input.uiMessageId,
        command: rawCommand,
        args: rest.join(' ').trim(),
        text,
        parts,
        source: input.source,
      };
    }
  }

  return {
    kind: 'message',
    sessionId: input.sessionId,
    uiMessageId: input.uiMessageId,
    text,
    parts,
    source: input.source,
  };
}

export const chatHookPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user-message'),
    message: z.string(),
    parts: z.array(z.custom<UserMessagePart>()).default([]),
    uiMessageId: z.string().optional(),
  }),
  z.object({
    type: z.literal('system-message'),
    message: z.string(),
  }),
  z.object({
    type: z.literal('control'),
    command: z.enum(['compact', 'cancel']),
    reason: z.string().optional(),
  }),
]);

export type ChatHookPayload = z.infer<typeof chatHookPayloadSchema>;

export const toolApprovalPayloadSchema = z.object({
  approved: z.boolean(),
  comment: z.string().optional(),
  toolCallId: z.string().optional(),
});

export type ToolApprovalPayload = z.infer<typeof toolApprovalPayloadSchema>;
