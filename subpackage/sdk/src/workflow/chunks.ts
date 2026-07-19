// Source: types/workflow.ts
//
// Mirrors the workflow message-stream chunk types and chat envelope
// types from the Web tier's source of truth (`types/workflow.ts`).
//
// The original file declares zod runtime schemas and infers types from
// them; the SDK only needs the *contract* shapes, so each schema is
// translated to a TypeScript interface / discriminated union without
// carrying the zod runtime. The runtime path is documented per type
// for drift detection.

import type { TokenUsageBucket, TokenUsage } from './types.js';

// Source: types/config/channels.ts — `AdapterName`.
// Re-declared locally to avoid the `@/types/config` alias.
export type AdapterName =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'teams'
  | 'gchat'
  | 'feishu'
  | 'qq'
  | 'wecom'
  | 'dingtalk';

// Source: types/config/language.ts — `BotLocale`.
// Re-declared locally to avoid the `@/types/config` alias.
export type BotLocale =
  | 'auto'
  | 'en-US'
  | 'en-GB'
  | 'zh-CN'
  | 'zh-TW'
  | 'zh-HK'
  | 'ja'
  | 'ko';

// ── Message parts / versions / metadata ────────────────────────────

/**
 * A single message part — text or file. Shared across all message
 * versions.
 *
 * Source: types/workflow.ts
 */
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
 * Source: types/workflow.ts
 */
export interface MessageVersion {
  parts: MessagePart[];
  createdAt: string;
  response?: MessagePart[];
}

/**
 * Per-message metadata attached to a `WorkflowUIMessage`.
 *
 * Source: types/workflow.ts
 */
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

// ── Sandbox lifecycle events ───────────────────────────────────────

/**
 * Discriminated union of all sandbox / runtime lifecycle event names
 * emitted by the workflow DevKit.
 *
 * Source: types/workflow.ts — `runtimeEventPayloadSchema.event` enum.
 */
export type RuntimeEventName =
  | 'sandbox-created'
  | 'sandbox-reused'
  | 'sandbox-command-start'
  | 'sandbox-command-finish'
  | 'sandbox-command-running'
  | 'sandbox-port-url'
  | 'sandbox-export-start'
  | 'sandbox-export-finish'
  | 'sandbox-export-failed'
  | 'sandbox-stopped'
  | 'workflow-cancelled'
  | 'runtime-error';

/**
 * Payload for a sandbox/runtime lifecycle event. Mirrors the zod
 * `runtimeEventPayloadSchema`.
 *
 * Source: types/workflow.ts
 */
export interface RuntimeEventPayload {
  event: RuntimeEventName;
  sessionId: string;
  runId?: string | null;
  sandboxId?: string | null;
  command?: string | null;
  exitCode?: number | null;
  status?: string | null;
  message?: string | null;
}

// ── Workflow status / message data (discriminated unions) ──────────

/**
 * System-event message chunk. Mirrors `workflowMessageDataSchema`.
 *
 * Source: types/workflow.ts
 */
export interface WorkflowMessageData {
  kind: 'message';
  type: 'system-event';
  agentName?: string;
  eventType: string;
  message: string;
}

/**
 * Workflow status chunk. Mirrors the discriminated union
 * `workflowStatusDataSchema` (7 variants).
 *
 * Source: types/workflow.ts
 */
export type WorkflowStatusData =
  | {
      kind: 'status';
      type: 'runtime-event';
      agentName?: string;
      payload: RuntimeEventPayload;
    }
  | {
      kind: 'status';
      type: 'token-usage';
      agentName?: string;
      usage: TokenUsage;
    }
  | {
      kind: 'status';
      type: 'step-finish';
      agentName?: string;
      stepNumber: number;
      finishReason: string;
      totalTokens: number;
      inputTokens?: TokenUsageBucket;
      outputTokens?: TokenUsageBucket;
      messageIds: string[];
    }
  | {
      kind: 'status';
      type: 'user-message';
      agentName?: string;
      content: string;
      uiMessageId?: string | null;
      internal: true;
    }
  | {
      kind: 'status';
      type: 'local-tool-request';
      agentName?: string;
      /**
       * The toolCallId the LLM emitted. The CLI uses this as the hook
       * resume token when POSTing the result back to
       * /api/ai/[runId]/tool-result.
       */
      toolCallId: string;
      /** Tool name as the model emitted it (e.g. "local_read_file"). */
      toolName: string;
      /** The validated input object the model passed to the tool. */
      toolInput: unknown;
    }
  | {
      kind: 'status';
      type: 'subagent-event';
      agentName?: string;
      subagentId: string;
      subagentName: string;
      event: 'started' | 'completed' | 'failed';
      task: string;
      summary?: string;
      error?: string;
      steps?: number;
      modelId?: string;
    }
  | {
      kind: 'status';
      type: 'subagent-batch-event';
      agentName?: string;
      batchId: string;
      event: 'spawned' | 'completed' | 'cancelled';
      concurrencyLimit: number;
      total: number;
      succeeded?: number;
      failed?: number;
      cancelled?: number;
      summary?: string;
    };

/**
 * One chunk emitted on the workflow's UI-message stream. Mirrors the
 * zod `workflowDataSchema` discriminated union on `kind`.
 *
 * Source: types/workflow.ts
 */
export type WorkflowDataPart = WorkflowMessageData | WorkflowStatusData;

// ── UI message wrappers ────────────────────────────────────────────
//
// The runtime's `WorkflowUIMessage` is `UIMessage<ChatMessageMetadata,
// WorkflowUIDataParts>` from the Vercel AI SDK. The SDK does not depend
// on `ai`, so the structural shape is mirrored here directly.
//
// Source: types/workflow.ts — `WorkflowUIDataParts`, `WorkflowUIMessage`,
//                            `WorkflowUIMessageChunk`.

export type WorkflowUIDataParts = {
  workflow: WorkflowDataPart;
};

/**
 * Structural mirror of the Vercel AI SDK's `UIMessage` specialized to
 * the workflow's metadata and data-part shapes.
 *
 * Source: types/workflow.ts
 *
 * NOTE: `parts` mirrors `UIMessage['parts']` only structurally. The
 * real `ai` package owns the precise part discriminated union at
 * runtime. Consumers that need full part-type narrowing should depend
 * on `ai` directly.
 * TODO: tighten when ai-sdk types land as a real peer dep.
 */
export interface WorkflowUIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<
    | { type: 'text'; text: string; state?: unknown }
    | { type: 'file'; url: string; mediaType?: string; filename?: string }
    | {
        type: `data-${string}`;
        data: WorkflowDataPart;
      }
    | { type: string; [key: string]: unknown }
  >;
  metadata?: ChatMessageMetadata;
  createdAt?: string;
  [key: string]: unknown;
}

/**
 * One chunk emitted on the SSE stream consumed by clients of the
 * workflow run. Mirrors `UIMessageChunk` specialized to workflow.
 *
 * Source: types/workflow.ts
 *
 * TODO: tighten when ai-sdk types land as a real peer dep.
 */
export interface WorkflowUIMessageChunk {
  type: string;
  id?: string;
  role?: string;
  parts?: unknown[];
  data?: WorkflowDataPart;
  metadata?: ChatMessageMetadata;
  [key: string]: unknown;
}

// ── Chat source / envelope ─────────────────────────────────────────

/**
 * Source: types/workflow.ts — `WebChatSource`.
 */
export type WebChatSource = {
  type: 'web';
  userId?: string | null;
};

/**
 * Source: types/workflow.ts — `ScheduledChatSource`.
 */
export type ScheduledChatSource = {
  type: 'scheduled';
};

/**
 * Source: types/workflow.ts — `IMChatSource`.
 */
export type IMChatSource = {
  type: 'im';
  adapter: AdapterName;
  origin: string;
  threadId: string;
  messageId?: string | null;
  /**
   * Resolved ClawLess user id when a pairing exists; otherwise the raw
   * IM-platform id. Session, task, memory, and L2 scoping use this
   * field for multi-tenant isolation.
   */
  userId?: string | null;
  /**
   * Always the raw IM-platform id, even after a ClawLess user has been
   * resolved. Commands that key off the IM account (e.g. /whoami,
   * /unpair, /pair) must read this field, not `userId`.
   */
  rawImUserId?: string | null;
  userName?: string | null;
  locale?: BotLocale;
  /**
   * True when this IM message was routed to a CLI session via /attach.
   */
  remoteIm?: boolean;
  /** IM adapter name when remoteIm is true. */
  remoteAdapter?: AdapterName;
  /** IM thread ID when remoteIm is true. */
  remoteThreadId?: string;
};

/**
 * Source: types/workflow.ts — `CLIChatSource`.
 */
export type CLIChatSource = {
  type: 'cli';
  userId?: string | null;
  clientId: string;
  label?: string | null;
};

/**
 * Discriminated union of all chat-source variants.
 *
 * Source: types/workflow.ts — `ChatSource`.
 */
export type ChatSource =
  | WebChatSource
  | ScheduledChatSource
  | IMChatSource
  | CLIChatSource;

/**
 * User-authored message part narrowed to text/file. Used in chat input
 * envelopes.
 *
 * Source: types/workflow.ts — `UserMessagePart`.
 */
export type UserMessagePart = MessagePart;

/**
 * Message-kind chat input envelope.
 *
 * Source: types/workflow.ts — `MessageInputEnvelope`.
 */
export type MessageInputEnvelope = {
  kind: 'message';
  sessionId?: string;
  uiMessageId?: string;
  text: string;
  parts: UserMessagePart[];
  source: ChatSource;
};

/**
 * Command-kind chat input envelope (CLI slash commands).
 *
 * Source: types/workflow.ts — `CommandInputEnvelope`.
 */
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

/**
 * A user- or command-origin chat envelope handed to the workflow
 * dispatch layer.
 *
 * Source: types/workflow.ts — `ChatInputEnvelope`.
 */
export type ChatInputEnvelope = MessageInputEnvelope | CommandInputEnvelope;

// ── Session / message role ─────────────────────────────────────────

/**
 * Lifecycle status of a chat session.
 *
 * Source: types/workflow.ts — `SessionStatus`.
 */
export type SessionStatus = 'active' | 'completed' | 'stopped' | 'error';

/**
 * The persisted-message role tag stored on the DB row.
 *
 * Source: types/workflow.ts — `PersistedMessageRole`.
 */
export type PersistedMessageRole =
  | 'user'
  | 'assistant'
  | 'summary'
  | 'tool'
  | 'system';

// ── Command surface ────────────────────────────────────────────────

/**
 * Source: types/workflow.ts — `COMMANDS`.
 *
 * Internal mirror of the runtime's `as const` command list. Kept
 * module-private (not exported) so the SDK only surfaces the derived
 * `Command` type — exporting a second runtime command array would
 * create a parallel source of truth that drifts from the upstream
 * list the moment either side adds or removes an entry. Regenerate
 * by diffing against the source `COMMANDS` when `Command` consumers
 * report an unknown value.
 */
const COMMANDS = [
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

/**
 * Source: types/workflow.ts — `Command`.
 */
export type Command = (typeof COMMANDS)[number];

// ── Chat hook payload + tool approval (mirror of types/workflow.ts) ─
//
// These mirror the zod `chatHookPayloadSchema` and
// `toolApprovalPayloadSchema`. The standalone `approvalHook.ts` /
// `instructionHook.ts` schemas are kept in `./hooks.ts`; these two are
// declared in `types/workflow.ts` itself and are duplicated here so
// `chunks.ts` stays aligned with the source file's export order.

/**
 * Source: types/workflow.ts — `chatHookPayloadSchema`.
 */
export type ChatHookPayload =
  | {
      type: 'user-message';
      message: string;
      parts?: UserMessagePart[];
      uiMessageId?: string;
    }
  | {
      type: 'system-message';
      message: string;
    }
  | {
      type: 'control';
      command: 'compact' | 'cancel';
      reason?: string;
    };

/**
 * Source: types/workflow.ts — `toolApprovalPayloadSchema`.
 */
export interface ToolApprovalPayload {
  approved: boolean;
  comment?: string;
  toolCallId?: string;
}
