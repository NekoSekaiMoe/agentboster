import {
  normalizeToolOutputForPersistence,
  reconstructUIMessageParts,
  toModelMessage,
} from '@/lib/chat/message-utils';
import { getSessionMessages } from '@/lib/core/db/chat';
import {
  formatRecalledMemoriesForContext,
  getCurrentSessionSummary,
  recallRelevantMemories,
} from '@/lib/memory';
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

/**
 * Build the initial ModelMessage[] for a chat run.
 *
 * Optionally retrieves the top-K most relevant long-term memories for the
 * user's latest message and injects them as a system-prefixed user message
 * at the start. This auto-RAG path is the primary mechanism by which
 * personal context (location, preferences, schedule) reaches the model —
 * it does not rely on the agent proactively calling readMemory, which
 * small/mid models frequently skip even when prompted.
 *
 * Auto-RAG is opt-in via the `recallUserId` + `recallQuery` options. When
 * either is absent (e.g. anonymous chat, /init-agents-md path, compression
 * re-runs), no recall happens and the output matches the prior behavior.
 */
export async function buildInitialContextMessages(
  sessionId: string,
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
    /**
     * User id to scope the long-term memory recall. When null/undefined,
     * no auto-recall happens.
     */
    recallUserId?: string | null;
    /**
     * The user's latest message text, used as the semantic query for
     * memory recall. When null/undefined/empty, no auto-recall happens.
     */
    recallQuery?: string | null;
  },
): Promise<ModelMessage[]> {
  const [{ summaryText, modelMessages }, recalledMemories] = await Promise.all([
    buildPostSummaryConversationMessages(sessionId, options),
    options?.recallUserId && options?.recallQuery
      ? recallRelevantMemories({
          userId: options.recallUserId,
          query: options.recallQuery,
        })
      : Promise.resolve([]),
  ]);

  const recalledContext = formatRecalledMemoriesForContext(recalledMemories);

  const prefix: ModelMessage[] = [];
  if (recalledContext) {
    prefix.push({
      role: 'user',
      content: recalledContext,
    });
  }
  if (summaryText) {
    prefix.push(createSummaryModelMessage(summaryText));
  }

  return [...prefix, ...modelMessages];
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
