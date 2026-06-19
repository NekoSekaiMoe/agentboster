import { getBotCapabilities } from '@/lib/bot/adaptor';
import { sendRoutedSourceReply } from '@/lib/bot/reply';
import { getConfig } from '@/lib/core/kv/config';
import { getBaseBot } from '@/lib/bot/core';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import type { AdapterName } from '@/types/config/channels';

const imReplyLogger = createLogger('workflow.sender.bots');

function formatToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) =>
      segment.length > 0
        ? `${segment[0].toUpperCase()}${segment.slice(1)}`
        : segment,
    )
    .join(' ');
}

function buildApprovalReminderText(input: {
  toolName: string;
  toolCallId: string;
}): string {
  const toolLabel = formatToolName(input.toolName);

  return [
    'A tool action is waiting for your approval.',
    `Tool: ${toolLabel}`,
    `Call ID: ${input.toolCallId}`,
    '',
    `Approve: /approve ${input.toolCallId}`,
    `Reject: /reject ${input.toolCallId}`,
  ].join('\n');
}

export async function sendSourceReplyStep(input: {
  source: ChatSource;
  text: string;
}): Promise<boolean> {
  'use step';

  return sendRoutedSourceReply(input.source, input.text);
}

export async function sendApprovalRequestReminderStep(input: {
  source: ChatSource;
  toolName: string;
  toolCallId: string;
}): Promise<boolean> {
  'use step';

  return sendRoutedSourceReply(
    input.source,
    buildApprovalReminderText({
      toolName: input.toolName,
      toolCallId: input.toolCallId,
    }),
  );
}

/**
 * Per-run state for streaming IM replies from inside the workflow.
 *
 * The workflow runtime outlives the webhook function that started it,
 * so the IM stream consumer must live inside the workflow. We intercept
 * the agent's text stream via experimental_transform and post/edit an
 * IM message on a throttled cadence — users see the message grow
 * roughly every FLUSH_INTERVAL_MS rather than only at step boundaries
 * (important for slow large models that emit tokens across many seconds
 * within a single step).
 *
 * - `messageId`: id of the growing IM message, once the first text has
 *   been posted. Stays null for non-edit adapters (feishu/qq), which
 *   must post a fresh message each flush.
 * - `accumulatedText`: full reply text accumulated across ALL chunks
 *   since the run started. editMessage replaces the whole message body,
 *   so we must track the complete text, not deltas.
 * - `pendingFlush`: true when a flush is scheduled but not yet run.
 *   Prevents stacking multiple timers.
 * - `inFlight`: true while a post/edit HTTP call is in progress. The
 *   next flush waits rather than issuing concurrent edits (IM platforms
 *   reject overlapping edits on the same message).
 * - `closed`: set by stopImReplyPump once the stream has ended; the
 *   final forced flush runs and no further timers are scheduled.
 * - `lastFlushedText`: the text body as of the last successful edit.
 *   Used by the throttle check and the "more text arrived since" guard.
 * - `canEdit` / `ttsEnabled`: cached capability/config flags.
 */
export interface ImReplyHolder {
  messageId: string | null;
  accumulatedText: string;
  lastFlushedText: string;
  pendingFlush: boolean;
  inFlight: boolean;
  closed: boolean;
  canEdit: boolean | null;
  ttsEnabled: boolean | null;
}

/** Min text length change OR time gap before we issue an editMessage. */
const FLUSH_INTERVAL_MS = 500;
const FLUSH_MIN_DELTA_CHARS = 20;

export function createImReplyHolder(): ImReplyHolder {
  return {
    messageId: null,
    accumulatedText: '',
    lastFlushedText: '',
    pendingFlush: false,
    inFlight: false,
    closed: false,
    canEdit: null,
    ttsEnabled: null,
  };
}

async function ensureHolderFlags(
  holder: ImReplyHolder,
  adapter: string,
): Promise<void> {
  if (holder.canEdit === null) {
    holder.canEdit = getBotCapabilities(adapter).edit;
  }
  if (holder.ttsEnabled === null) {
    try {
      const config = await getConfig();
      holder.ttsEnabled =
        config.channels?.[adapter as AdapterName]?.tts_enabled === true;
    } catch {
      holder.ttsEnabled = false;
    }
  }
}

/**
 * Issue (or schedule) an IM post/edit for the current accumulatedText.
 *
 * `force` is used by stopImReplyPump for the final flush — it bypasses
 * the throttle and waits for any in-flight edit to land first. Mid-run
 * calls (from the transform's text-delta observer) are throttled:
 * - if an edit is already in flight, do nothing (the next chunk will
 *   re-arm a timer)
 * - if the text delta since the last edit is small AND the last edit
 *   was recent, arm a timer instead of editing immediately
 */
function scheduleFlush(
  holder: ImReplyHolder,
  source: Extract<ChatSource, { type: 'im' }>,
  force = false,
): void {
  if (holder.closed && !force) return;
  if (holder.ttsEnabled) return; // voice clip posted once at end-of-run
  if (holder.pendingFlush) return;
  if (holder.inFlight && !force) return;

  const delay = force ? 0 : FLUSH_INTERVAL_MS;
  holder.pendingFlush = true;
  setTimeout(() => {
    void runFlush(holder, source, force);
  }, delay);
}

async function runFlush(
  holder: ImReplyHolder,
  source: Extract<ChatSource, { type: 'im' }>,
  force: boolean,
): Promise<void> {
  holder.pendingFlush = false;
  if (holder.inFlight) {
    // Another flush is mid-flight; re-arm if forced or there's pending text.
    if (force || holder.accumulatedText !== holder.lastFlushedText) {
      scheduleFlush(holder, source, force);
    }
    return;
  }

  const text = holder.accumulatedText;
  if (!text) return;

  // Throttle (non-forced) edits: skip if too little new text arrived.
  if (!force) {
    const delta = text.length - holder.lastFlushedText.length;
    if (delta < FLUSH_MIN_DELTA_CHARS) return;
  }

  holder.inFlight = true;
  try {
    await ensureHolderFlags(holder, source.adapter);
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);

    if (holder.canEdit && holder.messageId) {
      await adapter.editMessage(source.threadId, holder.messageId, {
        markdown: text,
      });
    } else {
      const posted = await adapter.postMessage(source.threadId, {
        markdown: text,
      });
      if (holder.canEdit) holder.messageId = posted.id;
      // non-edit adapters: leave messageId null → next flush posts again
    }
    holder.lastFlushedText = text;
  } catch (error) {
    imReplyLogger.warn('im_reply:flush_failed', {
      adapter: source.adapter,
      threadId: source.threadId,
      messageId: holder.messageId,
      forced: force,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    holder.inFlight = false;
    // If more text arrived during the edit, schedule another flush.
    if (!holder.closed && holder.accumulatedText !== holder.lastFlushedText) {
      scheduleFlush(holder, source, false);
    }
  }
}

/**
 * Build an experimental_transform that observes the agent's text stream
 * and drives the IM reply pump. Each text-delta chunk is accumulated
 * into the holder; every other chunk passes through untouched. A
 * tool-call chunk injects a visible divider so text emitted across a
 * tool boundary doesn't get glued together in the IM message.
 *
 * Returns null when the source isn't an IM channel we should stream to
 * (web sources use the web UI's own stream consumer; TTS-enabled IM
 * channels get a single voice clip at end-of-run instead of mid-run
 * text edits).
 *
 * The transform must preserve the TextStreamPart shape end-to-end:
 * streamText pipes our output through its own output/event transforms,
 * which expect well-formed chunks. We always enqueue the original chunk
 * unchanged; the IM-specific accumulation is a side effect.
 *
 * Typed as `unknown` here — the @workflow/ai StreamTextTransform
 * signature uses LanguageModelV3StreamPart while the runtime delivers
 * ai's TextStreamPart (a workflow SDK type mismatch). The caller casts
 * to whatever DurableAgent.stream expects.
 */
export function createImReplyTransform(
  holder: ImReplyHolder,
  source: ChatSource,
):
  | ((options: {
      tools: unknown;
      stopStream: () => void;
    }) => TransformStream<unknown, unknown>)
  | null {
  if (source.type !== 'im') return null;

  const seenToolCalls = new Set<string>();
  // Chunk shape is TextStreamPart<ToolSet> at runtime — a discriminated
  // union. Narrow by .type and read known fields via a minimal local
  // type; the full union is ToolSet-generic and not needed here.
  type ChunkLike = {
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
  };

  return () =>
    new TransformStream({
      transform(chunk: ChunkLike, controller) {
        // Pass through unchanged so the workflow writable and the web UI
        // still see the complete stream.
        controller.enqueue(chunk);

        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          holder.accumulatedText += chunk.text;
          scheduleFlush(holder, source, false);
        } else if (
          chunk.type === 'tool-call' &&
          chunk.toolCallId &&
          !seenToolCalls.has(chunk.toolCallId)
        ) {
          seenToolCalls.add(chunk.toolCallId);
          const label = chunk.toolName
            ? formatToolName(chunk.toolName)
            : 'tool';
          holder.accumulatedText += `\n\n🔧 ${label}...\n\n`;
          scheduleFlush(holder, source, false);
        }
      },
    });
}

/**
 * Stop the pump and run a final flush. Call this once the agent stream
 * has produced its last chunk. Waits for any in-flight edit to complete
 * (best-effort), then forces one more edit so the IM message reflects
 * the final full text.
 */
export async function stopImReplyPump(
  holder: ImReplyHolder,
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  holder.closed = true;
  await ensureHolderFlags(holder, source.adapter);
  if (!holder.accumulatedText.trim() || holder.ttsEnabled) return;
  // Force the final flush and wait for it.
  holder.inFlight = false;
  holder.pendingFlush = false;
  await runFlush(holder, source, true);
}
