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
  // non-deterministic within a step. That breaks the sequential grouping
  // below (orphan tool rows land at random positions, appearing to "jump
  // to the bottom" on reload).
  //
  // We sort primarily by createdAt so user/assistant/step ordering across
  // time is preserved (user messages have no stepNumber, so stepNumber
  // cannot be the primary key or all user turns collapse to the end).
  // stepNumber is only consulted as a tiebreaker among rows that share
  // the same createdAt (i.e. rows of one agent step), and within such a
  // tie the assistant text row must precede its tool rows.
  const stepRank = (r: PersistedMessageRecord) =>
    r.role === 'assistant' ? 0 : r.role === 'tool' ? 1 : 2;
  const orderedRows = [...rows].sort((a, b) => {
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    const aStep = a.stepNumber ?? Number.MAX_SAFE_INTEGER;
    const bStep = b.stepNumber ?? Number.MAX_SAFE_INTEGER;
    if (aStep !== bStep) return aStep - bStep;
    return stepRank(a) - stepRank(b);
  });

  const messages: WorkflowUIMessage[] = [];
  // runId of the last emitted assistant message, used to decide whether
  // the next assistant group belongs to the same agent turn and should
  // be merged into it. Kept separate from WorkflowUIMessage.metadata so
  // the internal marker never reaches the client.
  let lastEmittedRunId: string | undefined;
  let currentKey: string | null = null;
  let currentGroup: PersistedMessageRecord[] = [];

  // Reads the runId stamped by persistStepDeltaAndUsageStep (payload.metadata.runId).
  // Returns undefined for legacy rows / user rows, which disables merging.
  const runIdOf = (group: PersistedMessageRecord[]): string | undefined => {
    for (const row of group) {
      const meta = row.payload?.metadata as { runId?: unknown } | undefined;
      if (typeof meta?.runId === 'string') {
        return meta.runId;
      }
    }
    return undefined;
  };

  const flush = () => {
    if (currentGroup.length === 0) {
      currentKey = null;
      return;
    }

    const built = buildMessage(currentGroup);
    const runId = runIdOf(currentGroup);
    currentKey = null;
    currentGroup = [];

    // Coalesce consecutive assistant steps of the same agent turn into
    // one UI message. While streaming, AI SDK's ToolLoopAgent appends
    // every step's parts (reasoning/tool/text) onto a single UI message,
    // so reload must reconstruct the same single-message shape or the
    // user sees N split bubbles (each with its own action row and only
    // its own slice of reasoning) — the "tool cards jump below the
    // regenerate button / only first reasoning survives" symptom.
    if (
      runId &&
      built.role === 'assistant' &&
      messages.length > 0 &&
      lastEmittedRunId === runId
    ) {
      const prev = messages[messages.length - 1];
      if (prev.role === 'assistant') {
        prev.parts.push(...built.parts);
        // Reflect the turn's final state (last step wins) without
        // leaking runId into the public metadata.
        prev.metadata = built.metadata;
        return;
      }
    }

    messages.push(built);
    lastEmittedRunId = built.role === 'assistant' ? runId : undefined;
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
    // group, then emit the user row as its own single-row group. The
    // direct push bypasses lastEmittedRunId bookkeeping, so reset it
    // here to prevent a subsequent turn from merging with the previous.
    if (row.role === 'user') {
      flush();
      messages.push(buildMessage([row]));
      lastEmittedRunId = undefined;
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
  // Order rows inside one assistant step to match what the user saw
  // while streaming. AI SDK's ToolLoopAgent pushes parts onto the UI
  // message in chunk-arrival order: tool-input-available → tool-output →
  // text-delta, so the on-screen layout for a tool-using step is
  // [tool-card, text]. The StepResult that survives into persistence
  // loses that relative ordering (it has separate .text / .toolCalls
  // fields), so persistStepDeltaAndUsageStep writes the assistant text
  // row first and tool rows after — all sharing the same createdAt /
  // stepNumber. Restoring the streaming order here means ranking tool
  // rows ahead of the assistant text row.
  //
  // If partIndex is present on a row's payload (forward-compatible
  // marker that may be written in a future change), prefer it so any
  // explicit streaming order wins over the static rank.
  const rank = (r: PersistedMessageRecord) =>
    r.role === 'tool' ? 0 : r.role === 'assistant' ? 1 : 2;
  const ordered = [...groupRows].sort((a, b) => {
    const aPartIdx = (a.payload as { partIndex?: unknown }).partIndex;
    const bPartIdx = (b.payload as { partIndex?: unknown }).partIndex;
    if (
      typeof aPartIdx === 'number' &&
      typeof bPartIdx === 'number' &&
      aPartIdx !== bPartIdx
    ) {
      return aPartIdx - bPartIdx;
    }
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
      const rowMeta = row.payload.metadata as
        | Record<string, unknown>
        | undefined;
      if (rowMeta) {
        // runId is an internal marker used only by deserializePersistedMessages
        // to coalesce steps; strip it so it never reaches the UI message.
        const { runId: _drop, ...publicMeta } = rowMeta;
        metadata = publicMeta as WorkflowUIMessage['metadata'];
      }
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
