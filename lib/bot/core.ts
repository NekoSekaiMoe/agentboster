import { getConfig } from '@/lib/core/kv/config';
import type { AppConfig } from '@/types/config';
import { Chat } from 'chat';
import { redisState } from '../core/kv';
import { createBotAdapters } from './adaptor';

type CreateBaseBotOptions = {
  agentName?: string | null;
};

function resolveBotUserName(options?: CreateBaseBotOptions): string {
  const agentName = options?.agentName?.trim();
  if (!agentName) {
    return 'main';
  }

  return agentName;
}

export async function createBaseBotFromConfig(
  config: AppConfig,
  options?: CreateBaseBotOptions,
): Promise<Chat> {
  const adapters = await createBotAdapters(config?.channels);

  return new Chat({
    adapters,
    state: redisState,
    userName: resolveBotUserName(options),
  });
}

export async function getBaseBot(
  options?: CreateBaseBotOptions,
): Promise<Chat> {
  const config = await getConfig();
  return createBaseBotFromConfig(config, options);
}
