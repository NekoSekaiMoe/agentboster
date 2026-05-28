'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  getAppBaseUrl,
  getBotAuthSecret,
  getWebhookCallbackUrl,
} from '@/lib/bot/webhook';
import { getConfig, setConfig } from '@/lib/core/kv/config';
import {
  type RuntimeHealthSnapshot,
  getRuntimeHealthSnapshot,
} from '@/lib/utils/runtime-health';
import { getBuildInToolCatalog } from '@/lib/workflow/agent/tools';
import { type AppConfig, appConfigSchema } from '@/types/config';
import { ADAPTER_NAMES, type AdapterName } from '@/types/config/channels';
import {
  type ToolCatalogResponse,
  toolCatalogResponseSchema,
} from '@/types/config/tools';
import { cookies } from 'next/headers';

export type ConfigLoadResponse = {
  config: AppConfig;
  runtimeHealth: RuntimeHealthSnapshot | null;
};

export type WebhookConfigResponse = {
  authSecretConfigured: boolean;
  baseUrl: string;
  urls: Record<AdapterName, string | null>;
};

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

export async function loadConfigAction(): Promise<ConfigLoadResponse> {
  await requireAuth();

  return {
    config: await getConfig(),
    runtimeHealth: getRuntimeHealthSnapshot(),
  };
}

export async function saveConfigAction(input: unknown): Promise<AppConfig> {
  await requireAuth();

  const config = appConfigSchema.parse(input);
  return setConfig(config);
}

export async function loadWebhookConfigAction(): Promise<WebhookConfigResponse> {
  await requireAuth();

  const urls = Object.fromEntries(
    ADAPTER_NAMES.map((adapter) => [adapter, getWebhookCallbackUrl(adapter)]),
  ) as Record<AdapterName, string | null>;

  return {
    authSecretConfigured: Boolean(getBotAuthSecret()),
    baseUrl: getAppBaseUrl(),
    urls,
  };
}

export async function loadToolCatalogAction(): Promise<ToolCatalogResponse> {
  await requireAuth();

  const config = await getConfig();
  return toolCatalogResponseSchema.parse(getBuildInToolCatalog(config));
}
