import { getBotCapabilities } from '@/lib/bot/capabilities';
import type { ChatSource } from '@/types/workflow';
import { createLogger } from '@/lib/utils/logger';
import {
  flushImReplyStep,
  startImTypingStep,
  stopImTypingStep,
} from './bot-steps';

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

/**
 * Per-run state for IM replies driven from inside the workflow.
 *
 * The workflow runtime outlives the webhook function that started it,
 * so the IM message lifecycle must live inside the workflow. We post/
 * edit the IM message at each onStepFinish (durable step boundary) —
 * step.text is a plain string, fully serializable, so this model is
 * compatible with the workflow runtime's Devalue-based persistence.
 *
 * The earlier experimental_transform approach (intercepting text-delta
 * chunks) does NOT work in durable workflows: the transform is a
 * function, and the workflow runtime serializes every step argument,
 * rejecting functions with "Cannot stringify a function".
 *
 * - `messageId`: id of the growing IM message. null until the first
 *   text-bearing step posts it. Stays null between calls for adapters
 *   that cannot edit (feishu/qq), so every step posts a fresh message.
 * - `accumulatedText`: full reply text accumulated across all steps.
 *   editMessage replaces the whole message body, so we track the
 *   complete text rather than per-step deltas.
 * - `canEdit` / `ttsEnabled`: cached capability/config flags.
 * - `typingTimer`: handle of the typing-indicator refresh interval.
 *   Telegram's typing indicator expires after ~5s; we refresh it on a
 *   cadence so the indicator stays on for the whole run.
 */
export interface ImReplyHolder {
  messageId: string | null;
  accumulatedText: string;
  canEdit: boolean | null;
  ttsEnabled: boolean | null;
  typingTimer: ReturnType<typeof setInterval> | null;
}

const TYPING_REFRESH_MS = 4500;

export function createImReplyHolder(options?: {
  adapter?: string;
  ttsEnabled?: boolean;
}): ImReplyHolder {
  return {
    messageId: null,
    accumulatedText: '',
    canEdit: options?.adapter ? getBotCapabilities(options.adapter).edit : null,
    ttsEnabled: options?.ttsEnabled ?? false,
    typingTimer: null,
  };
}

/**
 * Start the IM typing indicator for the run. Call once at the start of
 * chatWorkflow for IM sources. The indicator auto-expires (~5s on
 * Telegram); we refresh it on an interval until stopImReplyPump clears
 * the timer. Best-effort — failures (unsupported adapter, transient
 * API error) are swallowed.
 */
export async function startImTyping(
  holder: ImReplyHolder,
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  const refresh = () => {
    void startImTypingStep(source).catch((error) => {
      imReplyLogger.warn('im_typing:refresh_failed', {
        adapter: source.adapter,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  refresh();
  holder.typingTimer = setInterval(refresh, TYPING_REFRESH_MS);
}

/**
 * Append a step's text to the growing IM reply. Called from
 * chatWorkflow's onStepFinish — `stepText` is the model's text output
 * for that step (a string, fully serializable).
 *
 * For edit-capable adapters (telegram/discord/slack/teams/gchat): the
 * first text-bearing step posts the message and captures its id;
 * subsequent steps editMessage the same id with the full accumulated
 * text. When a step also invoked tools, a divider is inserted so the
 * user sees where the agent paused to call a tool.
 *
 * For non-edit-capable adapters (feishu/qq): every text-bearing step
 * posts a new message containing the full accumulated reply. messageId
 * stays null between calls.
 *
 * TTS-enabled channels are skipped here — one voice clip is synthesized
 * from the accumulated text at end-of-run instead.
 */
export async function streamImStepReplyStep(input: {
  source: Extract<ChatSource, { type: 'im' }>;
  holder: ImReplyHolder;
  stepText: string;
  toolNames?: string[];
}): Promise<void> {
  'use step';

  const text = input.stepText.trim();
  if (!text) return;
  if (input.holder.ttsEnabled) return;

  if (input.holder.canEdit === null) {
    input.holder.canEdit = getBotCapabilities(input.source.adapter).edit;
  }

  // Append this step's text to the accumulated body. When the step
  // also invoked tools, separate the previous content from the new
  // text with a visible divider (IM channels have no native tool-call
  // affordance).
  const divider =
    input.toolNames && input.toolNames.length > 0
      ? `\n\n🔧 ${input.toolNames.map(formatToolName).join(', ')}...\n\n`
      : '';
  const newBlock = divider + text;
  input.holder.accumulatedText =
    input.holder.accumulatedText.length > 0
      ? `${input.holder.accumulatedText}${newBlock}`
      : text;

  try {
    const result = await flushImReplyStep({
      source: input.source,
      action: input.holder.canEdit && input.holder.messageId ? 'edit' : 'post',
      messageId: input.holder.messageId,
      text: input.holder.accumulatedText,
    });

    if (result.ok) {
      if (input.holder.canEdit) {
        input.holder.messageId = result.messageId;
      }
      // non-edit adapters: leave messageId null → next step posts again.
    }
  } catch (error) {
    imReplyLogger.warn('im_step_reply:failed', {
      adapter: input.source.adapter,
      threadId: input.source.threadId,
      messageId: input.holder.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stop the pump: clear the typing indicator and (for TTS channels)
 * leave accumulatedText in place so the caller can synthesize a voice
 * clip from it. Call once at the end of chatWorkflow for IM sources.
 */
export async function stopImReplyPump(
  holder: ImReplyHolder,
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  if (holder.typingTimer) {
    clearInterval(holder.typingTimer);
    holder.typingTimer = null;
  }
  // Best-effort final typing clear (some adapters accept this).
  await stopImTypingStep(source).catch(() => {
    // not all adapters support stopping typing; ignore
  });
}
