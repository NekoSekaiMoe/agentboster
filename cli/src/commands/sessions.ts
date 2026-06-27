import { CLI_CONFIG_FILE } from '../lib/config';
import { createApiClient } from '../lib/api';
import { readJson } from '../lib/store';

export async function sessionsCommand(opts: { url: string }): Promise<void> {
  const stored = readJson<{ url?: string; token?: string }>(CLI_CONFIG_FILE);
  const api = createApiClient(opts.url || stored?.url || '', stored?.token);
  const result = await api.listSessions();
  for (const session of result.sessions) {
    console.log(
      `${session.id}\t${session.title?.trim() || 'Untitled'}\t${session.model ?? 'default'}`,
    );
  }
}
