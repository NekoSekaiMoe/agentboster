import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
} from '@ai-sdk/provider';
import type { DynamicToolUIPart, ModelMessage, UserContent } from 'ai';

import {
  type ClawlessAttachmentMetadata,
  attachClawlessAttachmentMetadata,
  createAttachmentTextContext,
  getClawlessAttachmentMetadata,
  isAudioOrVideoAttachmentMediaType,
  isDocumentAttachment,
  isImageAttachmentMediaType,
} from '@/lib/chat/attachment-metadata';
import { generateUUID } from '@/lib/utils';
import { createLogger } from '@/lib/utils/logger';
import type { TokenUsage } from '@/lib/workflow/agent/types';
import type {
  ChatMessageMetadata,
  ChatSource,
  PersistedMessageRole,
  WorkflowMessageData,
  WorkflowUIMessage,
} from '@/types/workflow';

const logger = createLogger('message-utils');

type MessagePart = WorkflowUIMessage['parts'][number];
type UserPromptContent = Extract<
  LanguageModelV3Prompt[number],
  { role: 'user' }
>['content'];
type AssistantPromptContent = Extract<
  LanguageModelV3Prompt[number],
  { role: 'assistant' }
>['content'];
type ToolPromptContent = Extract<
  LanguageModelV3Prompt[number],
  { role: 'tool' }
>['content'];
type ModelMessagePart = Exclude<ModelMessage['content'], string>[number];
type ModelFileData =
  | Extract<ModelMessagePart, { type: 'file' }>['data']
  | Extract<ModelMessagePart, { type: 'image' }>['image'];
type ModelToolResultOutput = Extract<
  ModelMessagePart,
  { type: 'tool-result' }
>['output'];
type ToolResultOutput = Extract<
  ToolPromptContent[number],
  { type: 'tool-result' }
>['output'];
type ModelToolResultContentPart = Extract<
  Extract<ModelToolResultOutput, { type: 'content' }>,
  { type: 'content' }
>['value'][number];
type ToolResultContentPart = Extract<
  Extract<ToolResultOutput, { type: 'content' }>,
  { type: 'content' }
>['value'][number];
type ParsedToolApproval = {
  id: string;
  approved?: boolean;
  reason?: string;
};

export const TOOL_OUTPUT_MAX_CHARS = 50_000;

export interface PersistedMessagePayload extends Record<string, unknown> {
  text?: string;
  parts?: WorkflowUIMessage['parts'];
  attachments?: ClawlessAttachmentMetadata[];
  finishReason?: string | null;
  usage?: TokenUsage;
  toolCallId?: string;
  toolName?: string;
  toolState?: DynamicToolUIPart['state'];
  approval?: DynamicToolUIPart['approval'];
  input?: unknown;
  output?: unknown;
  error?: string;
  source?: ChatSource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SerializedMessageForDB {
  sessionId: string;
  role: PersistedMessageRole;
  payload: PersistedMessagePayload;
  visibleInChat?: boolean;
  uiMessageId?: string | null;
  stepNumber?: number | null;
  createdAt?: Date;
}

export interface PersistedMessageRecord extends SerializedMessageForDB {
  id: string;
  createdAt: Date;
}

export function truncateMiddleText(
  text: string,
  maxChars = TOOL_OUTPUT_MAX_CHARS,
): string {
  if (maxChars <= 0) {
    return '';
  }

  if (text.length <= maxChars) {
    return text;
  }

  const markerTemplate = (omitted: number) =>
    `...[omitted ${omitted} chars, try changing the tool calling schema or add pagination to reduce the output.]...`;
  let marker = markerTemplate(text.length - maxChars);

  if (marker.length >= maxChars) {
    return marker.slice(0, maxChars);
  }

  let remaining = maxChars - marker.length;
  let headLength = Math.floor(remaining / 2);
  let tailLength = remaining - headLength;
  let omittedChars = text.length - (headLength + tailLength);

  // Recompute once because omitted-count width can change marker length.
  marker = markerTemplate(omittedChars);
  if (marker.length >= maxChars) {
    return marker.slice(0, maxChars);
  }
  remaining = maxChars - marker.length;
  headLength = Math.floor(remaining / 2);
  tailLength = remaining - headLength;
  omittedChars = text.length - (headLength + tailLength);
  marker = markerTemplate(omittedChars);

  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

export function normalizeToolOutputForPersistence(
  value: unknown,
  maxChars = TOOL_OUTPUT_MAX_CHARS,
): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            const serialized = JSON.stringify(value, null, 2);
            return serialized ?? String(value);
          } catch {
            return String(value);
          }
        })();

  return truncateMiddleText(text, maxChars);
}

export function extractTextFromParts(
  parts: WorkflowUIMessage['parts'],
): string {
  return parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
}

function buildUserParts(
  text: string,
  parts?: WorkflowUIMessage['parts'],
): WorkflowUIMessage['parts'] {
  if (parts && parts.length > 0) {
    return parts;
  }

  return text.length > 0 ? [{ type: 'text', text }] : [];
}

function createTextPart(text: string): Extract<MessagePart, { type: 'text' }> {
  return { type: 'text', text };
}

export function serializeUserMessage(input: {
  sessionId: string;
  uiMessageId?: string | null;
  text: string;
  parts?: WorkflowUIMessage['parts'];
  attachments?: ClawlessAttachmentMetadata[];
  source?: ChatSource;
  createdAt?: Date;
  metadata?: ChatMessageMetadata;
}): SerializedMessageForDB {
  // Debug: log metadata when saving
  if (input.metadata?.versions) {
    logger.info('serializeUserMessage:versions', {
      messageId: input.uiMessageId,
      versionsLength: input.metadata.versions.length,
      currentVersionIndex: input.metadata.currentVersionIndex,
    });
  }

  return {
    sessionId: input.sessionId,
    role: 'user',
    uiMessageId: input.uiMessageId ?? null,
    visibleInChat: true,
    createdAt: input.createdAt,
    payload: {
      text: input.text,
      parts: buildUserParts(input.text, input.parts),
      attachments: input.attachments,
      source: input.source,
      createdAt: input.createdAt?.toISOString(),
      metadata: input.metadata,
    },
  };
}

export function serializeWorkflowMessage(input: {
  sessionId: string;
  data: WorkflowMessageData;
  uiMessageId?: string | null;
  createdAt?: Date;
}): SerializedMessageForDB {
  return {
    sessionId: input.sessionId,
    role: 'assistant',
    uiMessageId: input.uiMessageId ?? generateUUID(),
    visibleInChat: true,
    createdAt: input.createdAt,
    payload: {
      parts: [
        {
          type: 'data-workflow',
          data: input.data,
        },
      ],
      createdAt: input.createdAt?.toISOString(),
      metadata: {
        createdAt: input.createdAt?.toISOString(),
      },
    },
  };
}

export function serializeAssistantMessage(input: {
  sessionId: string;
  text: string;
  reasoningText?: string;
  stepNumber?: number;
  finishReason?: string | null;
  usage?: TokenUsage;
  createdAt?: Date;
}): SerializedMessageForDB {
  const parts: MessagePart[] = [];
  const reasoning = (input.reasoningText ?? '').trim();
  if (reasoning.length > 0) {
    parts.push({ type: 'reasoning', text: reasoning, state: 'done' });
  }
  if (input.text.length > 0) {
    parts.push(createTextPart(input.text));
  }

  return {
    sessionId: input.sessionId,
    role: 'assistant',
    uiMessageId: generateUUID(),
    visibleInChat: true,
    stepNumber: input.stepNumber ?? null,
    createdAt: input.createdAt,
    payload: {
      text: input.text,
      parts,
      finishReason: input.finishReason ?? null,
      usage: input.usage,
      createdAt: input.createdAt?.toISOString(),
      metadata:
        input.stepNumber === undefined && input.finishReason === undefined
          ? undefined
          : {
              stepNumber: input.stepNumber,
              finishReason: input.finishReason ?? undefined,
              createdAt: input.createdAt?.toISOString(),
            },
    },
  };
}

export function serializeToolMessage(input: {
  sessionId: string;
  uiMessageId?: string;
  stepNumber?: number;
  finishReason?: string | null;
  toolCallId: string;
  toolName: string;
  toolState: Extract<DynamicToolUIPart, { type: 'dynamic-tool' }>['state'];
  toolApproval?: DynamicToolUIPart['approval'];
  toolInput?: unknown;
  toolOutput?: unknown;
  error?: string;
  createdAt?: Date;
}): SerializedMessageForDB {
  return {
    sessionId: input.sessionId,
    role: 'tool',
    uiMessageId: input.uiMessageId ?? `tool:${input.toolCallId}`,
    visibleInChat: true,
    stepNumber: input.stepNumber ?? null,
    createdAt: input.createdAt,
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolState: input.toolState,
      approval: input.toolApproval,
      input: input.toolInput,
      output: input.toolOutput,
      error: input.error,
      createdAt: input.createdAt?.toISOString(),
      finishReason: input.finishReason ?? null,
    },
  };
}

export function serializeSummaryMessage(input: {
  sessionId: string;
  summaryText: string;
  createdAt?: Date;
}): SerializedMessageForDB {
  return {
    sessionId: input.sessionId,
    role: 'summary',
    visibleInChat: false,
    createdAt: input.createdAt,
    payload: {
      text: input.summaryText,
      createdAt: input.createdAt?.toISOString(),
    },
  };
}

export function serializeSystemMessage(input: {
  sessionId: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}): SerializedMessageForDB {
  return {
    sessionId: input.sessionId,
    role: 'system',
    visibleInChat: false,
    createdAt: input.createdAt,
    payload: {
      text: input.text,
      metadata: input.metadata,
      createdAt: input.createdAt?.toISOString(),
    },
  };
}

export function reconstructUIMessageParts(
  row: Pick<PersistedMessageRecord, 'role' | 'payload'>,
): WorkflowUIMessage['parts'] {
  const parts = row.payload.parts;
  if (Array.isArray(parts)) {
    return parts as WorkflowUIMessage['parts'];
  }

  if (row.role === 'tool') {
    const toolName = row.payload.toolName;
    const toolCallId = row.payload.toolCallId;
    const isOutputAvailable =
      row.payload.toolState === 'output-available' ||
      (!row.payload.toolState && Object.hasOwn(row.payload, 'output'));

    if (typeof toolName !== 'string' || typeof toolCallId !== 'string') {
      return [];
    }

    const toolState =
      row.payload.toolState === 'approval-requested' ||
      row.payload.toolState === 'approval-responded' ||
      row.payload.toolState === 'output-denied' ||
      row.payload.toolState === 'output-error' ||
      row.payload.toolState === 'output-available' ||
      row.payload.toolState === 'input-streaming'
        ? row.payload.toolState
        : isOutputAvailable
          ? 'output-available'
          : 'input-available';

    const approval = parseToolApproval(row.payload.approval);

    const toolPart: DynamicToolUIPart =
      toolState === 'approval-requested'
        ? {
            type: 'dynamic-tool',
            toolName,
            toolCallId,
            input: row.payload.input,
            state: 'approval-requested',
            approval: {
              id: approval?.id ?? toolCallId,
            },
          }
        : toolState === 'approval-responded'
          ? {
              type: 'dynamic-tool',
              toolName,
              toolCallId,
              input: row.payload.input,
              state: 'approval-responded',
              approval: buildApprovalRespondedToolApproval(
                approval,
                toolCallId,
              ),
            }
          : toolState === 'output-denied'
            ? {
                type: 'dynamic-tool',
                toolName,
                toolCallId,
                input: row.payload.input,
                state: 'output-denied',
                approval: buildDeniedToolApproval(approval, toolCallId),
              }
            : toolState === 'output-error'
              ? {
                  type: 'dynamic-tool',
                  toolName,
                  toolCallId,
                  input: row.payload.input,
                  state: 'output-error',
                  approval: toApprovedToolApproval(approval),
                  errorText:
                    typeof row.payload.output === 'string'
                      ? row.payload.output
                      : typeof row.payload.error === 'string'
                        ? row.payload.error
                        : 'Tool execution failed.',
                }
              : toolState === 'output-available'
                ? {
                    type: 'dynamic-tool',
                    toolName,
                    toolCallId,
                    input: row.payload.input,
                    state: 'output-available',
                    approval: toApprovedToolApproval(approval),
                    output: row.payload.output,
                  }
                : toolState === 'input-streaming'
                  ? {
                      type: 'dynamic-tool',
                      toolName,
                      toolCallId,
                      input: row.payload.input,
                      state: 'input-streaming',
                    }
                  : {
                      type: 'dynamic-tool',
                      toolName,
                      toolCallId,
                      input: row.payload.input,
                      state: 'input-available',
                    };

    return [toolPart];
  }

  if (
    row.role === 'assistant' ||
    row.role === 'user' ||
    row.role === 'summary'
  ) {
    const rebuiltParts: WorkflowUIMessage['parts'] = [];
    const text = row.payload.text ?? '';

    if (text.length > 0) {
      rebuiltParts.push(createTextPart(text));
    }

    const attachments = extractPersistedAttachments(row.payload);
    for (const attachment of attachments) {
      rebuiltParts.push(
        attachClawlessAttachmentMetadata(
          {
            type: 'file',
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            url: attachment.blobUrl,
          },
          attachment,
        ),
      );
    }

    return rebuiltParts;
  }

  return [];
}

export function toModelMessage(
  row: Pick<PersistedMessageRecord, 'role' | 'payload'>,
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
  },
): ModelMessage | null {
  if (row.role === 'user') {
    const text = row.payload.text?.trim();
    const attachmentTextParts: Array<{ type: 'text'; text: string }> = [];
    const fileParts: Exclude<UserContent, string> = [];
    const attachments = extractPersistedAttachments(row.payload);
    const allowAttachmentParts = options?.allowFileParts ?? true;

    for (const attachment of attachments) {
      if (attachment.extractedText?.trim()) {
        attachmentTextParts.push({
          type: 'text',
          text: createAttachmentTextContext(attachment),
        });
        continue;
      }

      if (
        allowAttachmentParts &&
        isImageAttachmentMediaType(attachment.mediaType)
      ) {
        fileParts.push({
          type: 'image',
          image: attachment.modelUrl ?? attachment.blobUrl,
          mediaType: attachment.mediaType,
        });
        continue;
      }

      if (
        allowAttachmentParts &&
        canIncludeAttachmentAsFile(attachment.mediaType, attachment.filename)
      ) {
        fileParts.push({
          type: 'file',
          data: attachment.modelUrl ?? attachment.blobUrl,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
        });
        continue;
      }

      attachmentTextParts.push({
        type: 'text',
        text: createAttachmentTextContext(attachment),
      });
    }

    const textParts = text ? [{ type: 'text' as const, text }] : [];
    const content = [...textParts, ...attachmentTextParts, ...fileParts];
    if (content.length === 0) {
      return null;
    }

    return { role: 'user', content };
  }

  if (row.role === 'assistant') {
    const text = row.payload.text?.trim();
    if (!text) {
      return null;
    }

    return { role: 'assistant', content: text };
  }

  return null;
}

export function modelMessagesToPrompt(
  messages: ModelMessage[],
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  for (const message of messages) {
    if (message.role === 'system') {
      prompt.push({
        role: 'system',
        content: typeof message.content === 'string' ? message.content : '',
      });
      continue;
    }

    if (message.role === 'user') {
      prompt.push({
        role: 'user',
        content: toUserPromptContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      prompt.push({
        role: 'assistant',
        content: toAssistantPromptContent(message.content),
      });
      continue;
    }

    if (message.role === 'tool') {
      prompt.push({
        role: 'tool',
        content: toToolPromptContent(message.content),
      });
    }
  }

  return prompt;
}

function extractPersistedAttachments(
  payload: PersistedMessagePayload,
): ClawlessAttachmentMetadata[] {
  if (Array.isArray(payload.attachments)) {
    return payload.attachments;
  }

  if (!Array.isArray(payload.parts)) {
    return [];
  }

  return payload.parts.flatMap((part) => {
    const attachment = getClawlessAttachmentMetadata(
      part as WorkflowUIMessage['parts'][number],
    );
    return attachment ? [attachment] : [];
  });
}

function parseToolApproval(value: unknown): ParsedToolApproval | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const approval = value as Record<string, unknown>;
  if (typeof approval.id !== 'string') {
    return undefined;
  }

  return {
    id: approval.id,
    approved:
      typeof approval.approved === 'boolean' ? approval.approved : undefined,
    reason: typeof approval.reason === 'string' ? approval.reason : undefined,
  };
}

function toApprovedToolApproval(
  approval?: ParsedToolApproval,
): Extract<DynamicToolUIPart, { state: 'output-available' }>['approval'] {
  if (approval?.approved !== true) {
    return undefined;
  }

  if (approval.reason) {
    return {
      id: approval.id,
      approved: true,
      reason: approval.reason,
    };
  }

  return {
    id: approval.id,
    approved: true,
  };
}

function buildApprovalRespondedToolApproval(
  approval: ParsedToolApproval | undefined,
  fallbackId: string,
): Extract<DynamicToolUIPart, { state: 'approval-responded' }>['approval'] {
  if (approval?.approved === false) {
    if (approval.reason) {
      return {
        id: approval.id,
        approved: false,
        reason: approval.reason,
      };
    }

    return {
      id: approval.id,
      approved: false,
    };
  }

  if (approval?.reason) {
    return {
      id: approval?.id ?? fallbackId,
      approved: approval?.approved ?? true,
      reason: approval.reason,
    };
  }

  return {
    id: approval?.id ?? fallbackId,
    approved: approval?.approved ?? true,
  };
}

function buildDeniedToolApproval(
  approval: ParsedToolApproval | undefined,
  fallbackId: string,
): Extract<DynamicToolUIPart, { state: 'output-denied' }>['approval'] {
  if (approval?.reason) {
    return {
      id: approval.id,
      approved: false,
      reason: approval.reason,
    };
  }

  return {
    id: approval?.id ?? fallbackId,
    approved: false,
  };
}

function canIncludeAttachmentAsFile(mediaType: string, filename?: string) {
  if (isAudioOrVideoAttachmentMediaType(mediaType)) {
    return false;
  }

  return isDocumentAttachment(mediaType, filename);
}

function toUserPromptContent(
  messageContent: ModelMessage['content'],
): UserPromptContent {
  if (typeof messageContent === 'string') {
    return [{ type: 'text' as const, text: messageContent }];
  }

  const content: UserPromptContent = [];

  for (const part of messageContent) {
    if (part.type === 'text') {
      content.push(buildTextPromptPart(part.text));
      continue;
    }

    if (part.type === 'file') {
      content.push(
        buildFilePromptPart(part.data, part.mediaType, {
          filename: part.filename,
        }),
      );
      continue;
    }

    if (part.type === 'image') {
      content.push(
        buildFilePromptPart(part.image, part.mediaType ?? 'image/*'),
      );
    }
  }

  return content;
}

function toAssistantPromptContent(
  messageContent: ModelMessage['content'],
): AssistantPromptContent {
  if (typeof messageContent === 'string') {
    return [{ type: 'text' as const, text: messageContent }];
  }

  const content: AssistantPromptContent = [];

  for (const part of messageContent) {
    if (part.type === 'text') {
      content.push(buildTextPromptPart(part.text));
      continue;
    }

    if (part.type === 'file') {
      content.push(
        buildFilePromptPart(part.data, part.mediaType, {
          filename: part.filename,
        }),
      );
      continue;
    }

    if (part.type === 'image') {
      content.push(
        buildFilePromptPart(part.image, part.mediaType ?? 'image/*'),
      );
      continue;
    }

    if (part.type === 'reasoning') {
      // Skip on replay: DeepSeek rejects reasoning_content on input with 400.
      continue;
    }

    if (part.type === 'tool-call') {
      content.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        providerExecuted: part.providerExecuted,
      });
      continue;
    }

    if (part.type === 'tool-result') {
      content.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: normalizeToolResultOutput(part.output),
      });
    }
  }

  return content;
}

function toToolPromptContent(
  messageContent: ModelMessage['content'],
): ToolPromptContent {
  if (typeof messageContent === 'string') {
    return [];
  }

  const content: ToolPromptContent = [];

  for (const part of messageContent) {
    if (part.type !== 'tool-result') {
      continue;
    }

    content.push({
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: normalizeToolResultOutput(part.output),
    });
  }

  return content;
}

function buildTextPromptPart(text: string): LanguageModelV3TextPart {
  return {
    type: 'text',
    text,
  };
}

function buildFilePromptPart(
  data: ModelFileData,
  mediaType: string,
  options?: {
    filename?: string;
  },
): LanguageModelV3FilePart {
  return {
    type: 'file',
    data: normalizePromptFileData(data),
    mediaType,
    ...(options?.filename ? { filename: options.filename } : {}),
  };
}

function normalizePromptFileData(
  data: ModelFileData,
): LanguageModelV3FilePart['data'] {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return data;
}

function normalizeToolResultOutput(
  output: ModelToolResultOutput,
): ToolResultOutput {
  switch (output.type) {
    case 'text':
    case 'json':
    case 'error-text':
    case 'error-json':
      return output;
    case 'execution-denied':
      return {
        type: 'error-text' as const,
        value: output.reason?.trim()
          ? `Tool execution denied: ${output.reason}`
          : 'Tool execution denied.',
      };
    case 'content': {
      const content: ToolResultContentPart[] = [];

      for (const part of output.value) {
        const normalizedPart = normalizeToolResultContentPart(part);
        if (normalizedPart) {
          content.push(normalizedPart);
        }
      }

      if (content.length > 0) {
        return {
          type: 'content' as const,
          value: content,
        };
      }

      const text = output.value
        .map((part) => {
          switch (part.type) {
            case 'text':
              return part.text.trim();
            case 'file-url':
            case 'image-url':
              return part.url.trim();
            case 'file-id':
            case 'image-file-id':
              return typeof part.fileId === 'string'
                ? part.fileId
                : JSON.stringify(part.fileId);
            default:
              return '';
          }
        })
        .filter(Boolean)
        .join('\n\n');

      return {
        type: 'text' as const,
        value: text || '[tool returned non-text content]',
      };
    }
  }
}

function normalizeToolResultContentPart(
  part: ModelToolResultContentPart,
): ToolResultContentPart | null {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
      };
    case 'media':
      return isImageAttachmentMediaType(part.mediaType)
        ? {
            type: 'image-data',
            data: part.data,
            mediaType: part.mediaType,
          }
        : {
            type: 'file-data',
            data: part.data,
            mediaType: part.mediaType,
          };
    case 'file-data':
      return {
        type: 'file-data',
        data: part.data,
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {}),
      };
    case 'image-data':
      return {
        type: 'image-data',
        data: part.data,
        mediaType: part.mediaType,
      };
    case 'file-url':
      return {
        type: 'file-url',
        url: part.url,
      };
    case 'image-url':
      return {
        type: 'image-url',
        url: part.url,
      };
    case 'file-id':
      return {
        type: 'file-id',
        fileId: part.fileId,
      };
    case 'image-file-id':
      return {
        type: 'image-file-id',
        fileId: part.fileId,
      };
    case 'custom':
      return {
        type: 'custom',
      };
    default:
      return null;
  }
}
