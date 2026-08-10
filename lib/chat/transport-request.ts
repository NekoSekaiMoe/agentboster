import { useActiveWorkspaceStore } from '@/hooks/use-active-workspace-store';
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

/**
 * Per-request agent/persona name from the chat-box picker. When set,
 * overrides the hardcoded MAIN_AGENT_NAME ('main') for this single run
 * so the UI can switch between presets defined in config.agents. Empty /
 * missing falls back to 'main'. Validated against config.agents keys in
 * chatWorkflow before use — an unknown name is ignored (falls back to
 * main) rather than throwing, so stale UI state never breaks the chat.
 */
function getRequestAgent(body: Record<string, unknown>): string | undefined {
  return typeof body.agent === 'string' && body.agent.trim()
    ? body.agent.trim()
    : undefined;
}

/**
 * Active workspace from the shared client store, read at request-build
 * time (getState, not a hook subscription) so every send reflects the
 * workspace the user is looking at right now. The server validates
 * ownership + active status before scoping a NEW session to it
 * (SessionWorkspaceError → 4xx); existing sessions keep their own
 * recorded workspace regardless. Undefined when nothing is selected yet
 * — the server then falls back to the user's default workspace.
 */
function getRequestWorkspaceId(): string | undefined {
  return useActiveWorkspaceStore.getState().workspaceId ?? undefined;
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
      agent: getRequestAgent(bodyRecord),
      workspaceId: getRequestWorkspaceId(),
      input: {
        parts: targetParts,
        text: extractTextFromParts(targetParts),
      },
    },
  };
}
