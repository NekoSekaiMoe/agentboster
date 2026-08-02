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
import {
  DEEP_RECALL_MIN_CONFIDENCE,
  DEEP_RECALL_TOP_K,
  detectRecallIntent,
} from '@/lib/memory/recall-intent';
import {
  formatTriggeredMemoriesForContext,
  matchTriggeredMemories,
} from '@/lib/memory/triggers';
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
 *
 * `modelMessages` here is purely conversation history — the summary and
 * recalled-memory blocks are injected into the prefix AFTER this runs, so
 * there is no internal/prefixed message to filter out. The caller writes
 * the current user turn to the DB before building context, so the most
 * recent user message in `modelMessages` is `currentQuery` itself; we skip
 * that one so it isn't concatenated twice (which would also perturb the
 * recall cache key).
 */
function buildEnrichedRecallQuery(
  currentQuery: string,
  modelMessages: ModelMessage[],
): string {
  const recentUserTexts: string[] = [];
  let skippedCurrent = false;

  for (
    let i = modelMessages.length - 1;
    i >= 0 && recentUserTexts.length < RECENT_USER_MESSAGE_COUNT;
    i--
  ) {
    const msg = modelMessages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

    // The last user message is the current turn (already captured in
    // currentQuery); skip exactly one occurrence of it.
    if (!skippedCurrent) {
      skippedCurrent = true;
      continue;
    }

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
  let triggeredContext: string | null = null;
  if (options?.recallUserId && options?.recallQuery) {
    const enrichedQuery = buildEnrichedRecallQuery(
      options.recallQuery,
      modelMessages,
    );

    // Lane 2 escalation (OpenClaw active-memory `escalate` analogue):
    // when the message asks about the past, bypass the lane-1 cache and
    // pay for a wider, deeper retrieval — temporal / multi-hop questions
    // are exactly where default flat retrieval is weakest. Detection is
    // deterministic (regex, zero model calls) so the lane choice itself
    // costs nothing.
    const isRecallIntent = detectRecallIntent(options.recallQuery);

    // Trigger prefilter + semantic recall run in parallel; both are
    // best-effort and never reject.
    const [recalled, triggered] = await Promise.all([
      recallRelevantMemories({
        userId: options.recallUserId,
        query: enrichedQuery,
        config: effectiveConfig ?? undefined,
        ...(isRecallIntent
          ? {
              topK: DEEP_RECALL_TOP_K,
              minConfidence: DEEP_RECALL_MIN_CONFIDENCE,
              bypassCache: true,
            }
          : {}),
      }),
      // The prefilter matches against the RAW current message, not the
      // enriched multi-turn query — trigger phrases describe turn-level
      // intent, and older turns would only add noise.
      matchTriggeredMemories({
        userId: options.recallUserId,
        message: options.recallQuery,
      }),
    ]);
    recalledMemories = recalled;
    triggeredContext = formatTriggeredMemoriesForContext(triggered);
  }

  const recalledContext = formatRecalledMemoriesForContext(recalledMemories);

  const prefix: ModelMessage[] = [];
  if (triggeredContext) {
    prefix.push({
      role: 'user',
      content: triggeredContext,
    });
  }
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
