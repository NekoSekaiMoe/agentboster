import { CLI_CONFIG_FILE } from '../lib/config';
import { createApiClient } from '../lib/api';
import { readJson } from '../lib/store';

function createClientSessionId(): string {
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function chatCommand(input: {
  url?: string;
  sessionId?: string;
  model?: string;
  message?: string;
}): Promise<void> {
  const message = input.message?.trim();
  if (!message) {
    console.log('Interactive TUI is not implemented yet.');
    return;
  }

  const stored = readJson<{ url?: string; token?: string }>(CLI_CONFIG_FILE);
  const baseUrl = input.url ?? stored?.url;
  if (!baseUrl) {
    throw new Error('missing url');
  }

  const api = createApiClient(baseUrl, stored?.token);
  const sessionId = input.sessionId?.trim() || createClientSessionId();
  const response = await api.sendMessage({
    sessionId,
    message,
    model: input.model,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const detail = await api.getSessionMessages(sessionId);
  const lastAssistant = detail.messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;

  console.log(lastAssistant ?? '(no assistant reply yet)');
}
