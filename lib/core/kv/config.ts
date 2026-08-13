import { cache } from 'react';
import { get, set } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import { type AppConfig, CONFIG_KEY, appConfigSchema } from '@/types/config';
import { z } from 'zod';

const configPatchSchema = appConfigSchema.partial();
const logger = createLogger('kv.config');

const _getConfigUncached = async (): Promise<AppConfig> => {
  logger.log('getConfig:start');
  const raw = await get(CONFIG_KEY);
  if (!raw) {
    logger.warn('getConfig:empty');
    return {};
  }

  const parsed = appConfigSchema.parse(raw);
  logger.log('getConfig:success');
  return parsed;
};

export const getConfig = cache(_getConfigUncached);

export async function setConfig(input: unknown): Promise<AppConfig> {
  const config = appConfigSchema.parse(input);
  logger.info('setConfig:start', { topLevelKeys: Object.keys(config) });
  await set(CONFIG_KEY, JSON.stringify(config));
  logger.info('setConfig:success', { topLevelKeys: Object.keys(config) });
  return config;
}

export async function patchConfig(input: unknown): Promise<AppConfig> {
  const patch = configPatchSchema.parse(input);
  logger.info('patchConfig:start', { patchKeys: Object.keys(patch) });

  const current = await getConfig();
  const merged = appConfigSchema.parse({
    ...current,
    ...patch,
  });

  await set(CONFIG_KEY, JSON.stringify(merged));
  logger.info('patchConfig:success', { patchKeys: Object.keys(patch) });
  return merged;
}
