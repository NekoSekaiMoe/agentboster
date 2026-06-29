import type { WorkflowUIMessage, WorkflowUIPart } from '@/types/workflow';
import {
  type PersistedMessageRecord,
  reconstructUIMessageParts,
} from './message-utils';

/**
 * Deserialize persisted message rows back into UI messages.
 *
 * A single agent step that emits both text and tool calls is persisted as
 * multiple rows: one assistant row for the text, and one tool row per
 * tool call. Each tool row's uiMessageId is "<stepUiMessageId>#tool:<id>"
 * where <stepUiMessageId> is the same id used by the assistant text row.
 * When loading, we group rows by that "<stepUiMessageId>" prefix so the
 * UI renders the text and its tool cards as one assistant message —
 * otherwise each row becomes its own message and tool cards appear with
 * their own action buttons below the text, which is not what the user
 * saw during streaming.
 *
 * Rows that don't follow this convention (legacy `tool:<toolCallId>`
 * format, or anything without a `#` separator) fall through to
 * one-message-per-row behavior, matching the pre-fix status quo for
 * old sessions.
 *
 * The input rows are assumed to be in chronological order. We walk them
 * once, accumulating rows into the current group while they share the
 * same group key and are assistant/tool rows; any other row (user, or
 * a different key) flushes the current group and starts a new one.
 */
export function deserializePersistedMessages(
  rows: PersistedMessageRecord[],
): WorkflowUIMessage[] {
  // The DB query orders by (created_at, id). Rows produced by one agent
  // step share a single stepCreatedAt (millisecond precision), so the
  // tiebreak falls to the random UUID primary key — making row order
  // non-deterministic. That breaks the sequential grouping below
  // (orphan tool rows land at random positions, appearing to "jump to
  // the bottom" on reload). Pre-sort by a stable key so rows of the
  // same step are adjacent and in the right internal order before we
  // walk them. This is migration-free; a proper `position` column is
  // the long-term fix.
  const stepRank = (r: PersistedMessageRecord) =>
    r.role === 'assistant' ? 0 : r.role === 'tool' ? 1 : 2;
  const orderedRows = [...rows].sort((a, b) => {
    const aStep = a.stepNumber ?? Number.MAX_SAFE_INTEGER;
    const bStep = b.stepNumber ?? Number.MAX_SAFE_INTEGER;
    if (aStep !== bStep) return aStep - bStep;
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return stepRank(a) - stepRank(b);
  });

  const messages: WorkflowUIMessage[] = [];
  let currentKey: string | null = null;
  let currentGroup: PersistedMessageRecord[] = [];

  const flush = () => {
    if (currentGroup.length > 0) {
      messages.push(buildMessage(currentGroup));
    }
    currentKey = null;
    currentGroup = [];
  };

  for (const row of orderedRows) {
    if (!row.visibleInChat) {
      continue;
    }
    if (
      row.role !== 'user' &&
      row.role !== 'assistant' &&
      row.role !== 'tool'
    ) {
      continue;
    }

    // user rows are never grouped — flush the in-progress assistant
    // group, then emit the user row as its own single-row group.
    if (row.role === 'user') {
      flush();
      messages.push(buildMessage([row]));
      continue;
    }

    // For assistant/tool rows, group by the prefix before '#' (if any).
    // A row with no '#' uses its full uiMessageId as its own group,
    // which means "one message per row" for legacy data.
    const rawKey = row.uiMessageId ?? row.id;
    const key = rawKey.includes('#') ? rawKey.split('#', 1)[0] : rawKey;

    // Start a new group when the key changes; otherwise accumulate.
    if (key !== currentKey) {
      flush();
      currentKey = key;
    }
    currentGroup.push(row);
  }

  flush();

  return messages;
}

function buildMessage(groupRows: PersistedMessageRecord[]): WorkflowUIMessage {
  // Sort within a group so the assistant text row comes before tool rows
  // (text is persisted first in persistStepDeltaAndUsageStep). Fall back
  // to createdAt when role ordering is ambiguous.
  const ordered = [...groupRows].sort((a, b) => {
    const rank = (r: PersistedMessageRecord) =>
      r.role === 'assistant' ? 0 : r.role === 'tool' ? 1 : 2;
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    return aTime - bTime;
  });

  const parts: WorkflowUIPart[] = [];
  let metadata: WorkflowUIMessage['metadata'];
  let role: WorkflowUIMessage['role'] = 'assistant';
  let id: string | undefined;

  for (const row of ordered) {
    const rowParts = reconstructUIMessageParts(row);
    parts.push(...rowParts);

    if (row.role === 'user') {
      role = 'user';
    }
    // Use the group-key (prefix before '#') as the message id so the
    // reconstructed message has a stable id matching what streaming
    // produces for the same step.
    if (!id) {
      const rawId = row.uiMessageId ?? row.id;
      id = rawId.includes('#') ? rawId.split('#', 1)[0] : rawId;
    }
    // Prefer metadata from the assistant row (it carries stepNumber /
    // finishReason / createdAt), but fall back to tool-row metadata.
    if (!metadata) {
      metadata = row.payload.metadata as WorkflowUIMessage['metadata'];
    }
  }

  return {
    id: id ?? ordered[0].id,
    role,
    parts,
    metadata:
      metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}
