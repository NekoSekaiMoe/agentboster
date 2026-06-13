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

export type ChatMessageMetadata = {
  stepNumber?: number;
  finishReason?: string;
  createdAt?: string;
  toolName?: string;
  agentName?: string;
  editHistory?: Array<{
    parts: Array<
      | { type: 'text'; text: string }
      | {
          type: 'file';
          filename?: string;
          mediaType: string;
          url: string;
          providerMetadata?: unknown;
        }
    >;
    createdAt: string;
  }>;
  currentEditIndex?: number;
  generationHistory?: Array<{
    parts: Array<
      | { type: 'text'; text: string }
      | {
          type: 'file';
          filename?: string;
          mediaType: string;
          url: string;
          providerMetadata?: unknown;
        }
    >;
    createdAt: string;
  }>;
  currentGenerationIndex?: number;
};

const editHistoryEntrySchema = z.object({
  parts: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('file'),
        filename: z.string().optional(),
        mediaType: z.string(),
        url: z.string(),
        providerMetadata: z.unknown().optional(),
      }),
    ]),
  ),
  createdAt: z.string(),
});

export const chatMessageMetadataSchema = z.object({
  stepNumber: z.number().finite().optional(),
  finishReason: z.string().optional(),
  createdAt: z.string().optional(),
  toolName: z.string().optional(),
  agentName: z.string().optional(),
  editHistory: z.array(editHistoryEntrySchema).optional(),
  currentEditIndex: z.number().finite().optional(),
  generationHistory: z.array(editHistoryEntrySchema).optional(),
  currentGenerationIndex: z.number().finite().optional(),
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
  'models',
  'provider',
  'config',
  'memory',
  'pair',
  'start',
  'cancel',
  'reset',
  'retry',
  'version',
  'id',
  'lang',
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
  userId?: string | null;
  userName?: string | null;
  locale?: BotLocale;
};

export type ChatSource = WebChatSource | ScheduledChatSource | IMChatSource;

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
});

export const chatSourceSchema = z.discriminatedUnion('type', [
  webChatSourceSchema,
  scheduledChatSourceSchema,
  imChatSourceSchema,
]);

export function parseChatSource(value: unknown): ChatSource | null {
  const parsed = chatSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isImChatSource(value: unknown): value is IMChatSource {
  return imChatSourceSchema.safeParse(value).success;
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
