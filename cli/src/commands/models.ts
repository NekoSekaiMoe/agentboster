import { CLI_CONFIG_FILE } from '../lib/config';
import { createApiClient } from '../lib/api';
import { readJson } from '../lib/store';

export async function modelsCommand(opts: { url: string }): Promise<void> {
  const stored = readJson<{ url?: string; token?: string }>(CLI_CONFIG_FILE);
  const api = createApiClient(opts.url || stored?.url || '', stored?.token);
  const result = await api.listModels();
  for (const model of result.models) {
    console.log(
      `${model.id}\t${model.contextLimit ?? '-'}\t${model.maxOutputTokens ?? '-'}\t${model.temperature ?? '-'}`,
    );
  }
}
