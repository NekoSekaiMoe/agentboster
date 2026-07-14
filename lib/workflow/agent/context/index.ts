import {
  normalizeToolOutputForPersistence,
  reconstructUIMessageParts,
  toModelMessage,
} from '@/lib/chat/message-utils';
import { getSessionMessages } from '@/lib/core/db/chat';
import { getConfig } from '@/lib/core/kv/config';
import {
  formatRecalledMemoriesForContext,
  getCurrentSessionSummary,
  recallRelevantMemories,
} from '@/lib/memory';
import type { AppConfig } from '@/types/config';
import type { WorkflowUIMessage } from '@/types/workflow';
import type { ModelMessage } from 'ai';

const SUMMARY_MESSAGE_PREFIX = '[Conversation Summary]\n';

const RECENT_USER_MESSAGE_COUNT = 4;
const MAX_ENRICHED_QUERY_CHARS = 1600;
const MAX_HISTORY_MESSAGE_CHARS = 280;

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
 * Build an enriched recall query from the current message plus recent
 * user messages from history. This improves recall for messages that
 * reference prior context (e.g., "那个" / "that thing we discussed").
 */
function buildEnrichedRecallQuery(
  currentQuery: string,
  modelMessages: ModelMessage[],
): string {
  const recentUserTexts: string[] = [];

  for (let i = modelMessages.length - 1; i >= 0 && recentUserTexts.length < RECENT_USER_MESSAGE_COUNT; i--) {
    const msg = modelMessages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (msg.content.startsWith(SUMMARY_MESSAGE_PREFIX)) continue;
    if (msg.content.startsWith('[Relevant Long-term Memories]')) continue;

    const trimmed = msg.content.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    recentUserTexts.push(trimmed);
  }

  if (recentUserTexts.length === 0) return currentQuery;

  const parts = [currentQuery, ...recentUserTexts.reverse()];
  let combined = parts.join('\n');
  if (combined.length > MAX_ENRICHED_QUERY_CHARS) {
    combined = combined.slice(0, MAX_ENRICHED_QUERY_CHARS);
  }
  return combined;
}

export async function buildInitialContextMessages(
  sessionId: string,
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
    recallUserId?: string | null;
    recallQuery?: string | null;
    config?: AppConfig;
  },
): Promise<ModelMessage[]> {
  const effectiveConfig =
    options?.config ?? (await getConfig().catch(() => null));

  const { summaryText, modelMessages } =
    await buildPostSummaryConversationMessages(sessionId, options);

  let recalledMemories: Awaited<ReturnType<typeof recallRelevantMemories>> = [];
  if (options?.recallUserId && options?.recallQuery) {
    const enrichedQuery = buildEnrichedRecallQuery(
      options.recallQuery,
      modelMessages,
    );
    recalledMemories = await recallRelevantMemories({
      userId: options.recallUserId,
      query: enrichedQuery,
      config: effectiveConfig ?? undefined,
    });
  }

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
