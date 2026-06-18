import type { WorkflowUIMessage } from '@/types/workflow';

export type ChatSendTrigger =
  | 'submit-message'
  | 'regenerate-message'
  | 'route-message';

export function cloneUIParts(
  parts: WorkflowUIMessage['parts'],
): WorkflowUIMessage['parts'] {
  return JSON.parse(JSON.stringify(parts)) as WorkflowUIMessage['parts'];
}

export function extractTextFromParts(
  parts: WorkflowUIMessage['parts'],
): string {
  return parts
    .filter(
      (
        part,
      ): part is Extract<
        WorkflowUIMessage['parts'][number],
        { type: 'text' }
      > => part.type === 'text',
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequestModel(body: Record<string, unknown>): string | undefined {
  return typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : undefined;
}

export function buildChatSendRequestBody({
  id: chatId,
  messages,
  trigger,
  messageId,
  body,
}: {
  id: string;
  messages: WorkflowUIMessage[];
  trigger: ChatSendTrigger;
  messageId?: string;
  body?: unknown;
}) {
  const bodyRecord = isRecord(body) ? body : {};
  const bodyInput = isRecord(bodyRecord.input) ? bodyRecord.input : null;
  const editedParts = Array.isArray(bodyInput?.parts)
    ? (bodyInput.parts as WorkflowUIMessage['parts'])
    : null;

  const targetMessage =
    (messageId
      ? messages.find((message) => message.id === messageId)
      : undefined) ?? messages.at(-1);
  const targetParts =
    editedParts ??
    (targetMessage?.role === 'user' ? cloneUIParts(targetMessage.parts) : []);

  return {
    body: {
      id: chatId,
      trigger,
      messageId,
      model: getRequestModel(bodyRecord),
      input: {
        parts: targetParts,
        text: extractTextFromParts(targetParts),
      },
    },
  };
}
