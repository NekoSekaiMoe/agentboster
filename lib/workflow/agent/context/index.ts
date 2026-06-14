import {
  normalizeToolOutputForPersistence,
  reconstructUIMessageParts,
  toModelMessage,
} from '@/lib/chat/message-utils';
import { getSessionMessages } from '@/lib/core/db/chat';
import { getCurrentSessionSummary } from '@/lib/memory';
import type { WorkflowUIMessage } from '@/types/workflow';
import type { ModelMessage } from 'ai';

const SUMMARY_MESSAGE_PREFIX = '[Conversation Summary]\n';

export function createSummaryModelMessage(summaryText: string): ModelMessage {
  return {
    role: 'user',
    content: `${SUMMARY_MESSAGE_PREFIX}${summaryText}`,
  };
}

async function getConversationRowsAfterLatestSummary(sessionId: string) {
  const [summary, rows] = await Promise.all([
    getCurrentSessionSummary(sessionId),
    getSessionMessages(sessionId),
  ]);

  const latestSummaryIndex = rows.findLastIndex(
    (row) => row.role === 'summary',
  );

  return {
    summaryText: summary?.content ?? null,
    rows: latestSummaryIndex >= 0 ? rows.slice(latestSummaryIndex + 1) : rows,
  };
}

function mapToolRowToTextContextMessage(input: {
  toolName: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolState?: unknown;
  error?: unknown;
}): ModelMessage {
  const output =
    input.toolOutput === undefined &&
    typeof input.error === 'string' &&
    input.error.trim().length > 0
      ? input.error
      : input.toolOutput;
  const sections = [
    `[tool:${input.toolName}]`,
    typeof input.toolState === 'string' ? `state: ${input.toolState}` : null,
    input.toolInput === undefined
      ? null
      : `input:\n${normalizeToolOutputForPersistence(input.toolInput, 4_000)}`,
    output === undefined
      ? null
      : `output:\n${normalizeToolOutputForPersistence(output, 8_000)}`,
  ].filter((value): value is string => Boolean(value));

  // Persisted tool rows are historical context, not fresh tool outputs. Replay
  // them as text so OpenAI Responses HTTP does not create orphaned outputs.
  return {
    role: 'assistant',
    content: sections.join('\n\n'),
  };
}

export async function buildPostSummaryConversationMessages(
  sessionId: string,
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
  },
): Promise<{
  summaryText: string | null;
  uiMessages: Array<Omit<WorkflowUIMessage, 'id'>>;
  modelMessages: ModelMessage[];
}> {
  const { summaryText, rows } =
    await getConversationRowsAfterLatestSummary(sessionId);
  const uiMessageRows = rows.filter(
    (row) =>
      row.role === 'user' || row.role === 'assistant' || row.role === 'tool',
  );
  const modelMessages = rows.flatMap((row) => {
    if (row.role === 'tool' && typeof row.payload.toolName === 'string') {
      return [
        mapToolRowToTextContextMessage({
          toolName: row.payload.toolName,
          toolInput: row.payload.input,
          toolOutput: row.payload.output,
          toolState: row.payload.toolState,
          error: row.payload.error,
        }),
      ];
    }

    if (row.role !== 'user' && row.role !== 'assistant') {
      return [];
    }

    const message = toModelMessage(row, {
      modelId: options?.modelId,
      allowFileParts: options?.allowFileParts,
    });
    return message ? [message] : [];
  });

  return {
    summaryText,
    uiMessages: uiMessageRows.map((row) => ({
      role: row.role === 'user' ? 'user' : 'assistant',
      parts: reconstructUIMessageParts(row),
    })),
    modelMessages,
  };
}

export async function buildInitialContextMessages(
  sessionId: string,
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
  },
): Promise<ModelMessage[]> {
  const { summaryText, modelMessages } =
    await buildPostSummaryConversationMessages(sessionId, options);

  return summaryText
    ? [createSummaryModelMessage(summaryText), ...modelMessages]
    : modelMessages;
}

export async function buildCompressionConversationMessages(sessionId: string) {
  const { rows } = await getConversationRowsAfterLatestSummary(sessionId);

  return rows.flatMap((row) => {
    if (row.role === 'user' || row.role === 'assistant') {
      const message = toModelMessage(row, { allowFileParts: false });
      return message ? [message] : [];
    }

    if (row.role === 'tool' && typeof row.payload.toolName === 'string') {
      return [
        mapToolRowToTextContextMessage({
          toolName: row.payload.toolName,
          toolInput: row.payload.input,
          toolOutput: row.payload.output,
          toolState: row.payload.toolState,
          error: row.payload.error,
        }),
      ];
    }

    return [];
  });
}
