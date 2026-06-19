import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('workflow.sender.bot_steps');

type ImReplyAction = 'post' | 'edit';

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

  const { sendRoutedSourceReply } = await import('@/lib/bot/reply');
  return sendRoutedSourceReply(input.source, input.text);
}

export async function sendApprovalRequestReminderStep(input: {
  source: ChatSource;
  toolName: string;
  toolCallId: string;
}): Promise<boolean> {
  'use step';

  const { sendRoutedSourceReply } = await import('@/lib/bot/reply');
  return sendRoutedSourceReply(
    input.source,
    buildApprovalReminderText({
      toolName: input.toolName,
      toolCallId: input.toolCallId,
    }),
  );
}

export async function postAdapterVoiceReplyStep(input: {
  source: Extract<ChatSource, { type: 'im' }>;
  text: string;
}): Promise<boolean> {
  'use step';

  const { postAdapterVoiceReply } = await import('@/lib/bot/voice');
  return postAdapterVoiceReply(input.source, input.text);
}

export async function flushImReplyStep(input: {
  source: Extract<ChatSource, { type: 'im' }>;
  action: ImReplyAction;
  messageId?: string | null;
  text: string;
}): Promise<{ ok: boolean; messageId: string | null }> {
  'use step';

  const content = input.text.trim();
  if (!content) {
    return { ok: false, messageId: input.messageId ?? null };
  }

  try {
    const { getBaseBot } = await import('@/lib/bot/core');
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(input.source.adapter);
    const message = { markdown: input.text };

    if (input.action === 'edit' && input.messageId) {
      await adapter.editMessage(
        input.source.threadId,
        input.messageId,
        message,
      );
      return { ok: true, messageId: input.messageId };
    }

    const posted = await adapter.postMessage(input.source.threadId, message);
    return { ok: true, messageId: posted.id };
  } catch (error) {
    logger.warn('im_reply:flush_failed', {
      adapter: input.source.adapter,
      threadId: input.source.threadId,
      messageId: input.messageId,
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, messageId: input.messageId ?? null };
  }
}

/**
 * Trigger the IM typing indicator for one tick. Telegram's indicator
 * expires after ~5s, so the caller (lib/workflow/agent/sender/bots.ts)
 * refreshes it on an interval for the whole run. Best-effort: some
 * adapters don't support typing at all and reject the call silently.
 */
export async function startImTypingStep(
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  'use step';

  const { getBaseBot } = await import('@/lib/bot/core');
  const bot = await getBaseBot();
  const adapter = bot.getAdapter(source.adapter);
  await adapter.startTyping(source.threadId);
}

/**
 * Best-effort stop-typing hint. Not all adapters expose this; failures
 * are swallowed by the caller.
 */
export async function stopImTypingStep(
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  'use step';

  try {
    const { getBaseBot } = await import('@/lib/bot/core');
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);
    // chat SDK doesn't have a universal stopTyping; some adapters alias
    // it, others ignore it. Call defensively.
    await (
      adapter as { stopTyping?: (threadId: string) => Promise<void> }
    ).stopTyping?.(source.threadId);
  } catch {
    // best-effort
  }
}
