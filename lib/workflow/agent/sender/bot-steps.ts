import type { ChatSource } from '@/types/workflow';

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
