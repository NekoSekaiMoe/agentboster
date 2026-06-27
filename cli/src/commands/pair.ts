import { CLI_CONFIG_FILE } from '../lib/config';
import { createApiClient } from '../lib/api';
import { readJson } from '../lib/store';

export async function pairCommand(opts: {
  url?: string;
  adapter?: string;
}): Promise<void> {
  const stored = readJson<{ url?: string; token?: string }>(CLI_CONFIG_FILE);
  const baseUrl = opts.url ?? stored?.url;
  if (!baseUrl) {
    throw new Error('missing url');
  }

  const adapter = opts.adapter ?? 'slack';
  const api = createApiClient(baseUrl, stored?.token);
  const result = await api.generatePairCode(adapter);
  console.log(
    `Pair code: ${result.code} (expires in ${result.expiresIn}s)\nUse /pair <code> in the paired channel.`,
  );
}
