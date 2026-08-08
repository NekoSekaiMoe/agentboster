'use server';

import { requireAdminAccess, requireAuthAccess } from '@/lib/auth/access';
import {
  getAppBaseUrl,
  getBotAuthSecret,
  getWebhookCallbackUrl,
  registerChannelWebhooks,
} from '@/lib/bot/webhook';
import {
  listImAccountsForUser,
  unpairImAccountByClawlessUser,
} from '@/lib/core/db/im-accounts';
import { getConfig, setConfig } from '@/lib/core/kv/config';
import { getUserById } from '@/lib/core/db/users';
import {
  type RuntimeHealthSnapshot,
  getRuntimeHealthSnapshot,
} from '@/lib/utils/runtime-health';
import { createLogger } from '@/lib/utils/logger';
import { getBuildInToolCatalog } from '@/lib/workflow/agent/tools';
import { type AppConfig, appConfigSchema } from '@/types/config';
import { ofetch } from 'ofetch';
import { ADAPTER_NAMES, type AdapterName } from '@/types/config/channels';
import {
  type ToolCatalogResponse,
  toolCatalogResponseSchema,
} from '@/types/config/tools';
import { cookies } from 'next/headers';

const logger = createLogger('config/actions');

export type ConfigLoadResponse = {
  config: AppConfig;
  runtimeHealth: RuntimeHealthSnapshot | null;
  meta: { isAdmin: boolean };
};

export type WebhookConfigResponse = {
  authSecretConfigured: boolean;
  baseUrl: string;
  urls: Record<AdapterName, string | null>;
};

async function requireAuth() {
  const cookieStore = await cookies();
  return requireAuthAccess(cookieStore);
}

export async function loadConfigAction(): Promise<ConfigLoadResponse> {
  const access = await requireAuth();

  return {
    config: await getConfig(),
    runtimeHealth: getRuntimeHealthSnapshot(),
    meta: { isAdmin: access.isAdmin },
  };
}

export async function saveConfigAction(input: unknown): Promise<AppConfig> {
  const cookieStore = await cookies();
  await requireAdminAccess(cookieStore);

  const config = appConfigSchema.parse(input);

  // Auto-generate secret_token for Telegram if enabled but not provided.
  // This ensures the adapter can validate incoming X-Telegram-Bot-Api-Secret-Token headers.
  const telegram = config.channels?.telegram;
  if (
    telegram?.enabled &&
    telegram.bot_token &&
    !telegram.secret_token?.trim()
  ) {
    config.channels = {
      ...config.channels,
      telegram: {
        ...telegram,
        secret_token: crypto.randomUUID(),
      },
    };
  }

  const saved = await setConfig(config);

  // Register webhooks for enabled channels (e.g., Telegram)
  const webhookResults = await registerChannelWebhooks(config.channels);
  console.log('[saveConfigAction] webhook results:', webhookResults);
  const failures = webhookResults.filter((r) => !r.ok);
  if (failures.length > 0) {
    const errorMessages = failures
      .map((f) => `${f.adapter}: ${f.error}`)
      .join('; ');
    throw new Error(`Webhook registration failed: ${errorMessages}`);
  }

  return saved;
}

export async function loadWebhookConfigAction(): Promise<WebhookConfigResponse> {
  const cookieStore = await cookies();
  await requireAdminAccess(cookieStore);

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
  const cookieStore = await cookies();
  await requireAdminAccess(cookieStore);

  const config = await getConfig();
  return toolCatalogResponseSchema.parse(getBuildInToolCatalog(config));
}

export type ProviderModelListResponse = {
  /** Model ids from `GET {base_url}/models`. */
  models: string[];
  /** Model ids from `GET {embedding_base_url}/models` (empty when unset). */
  embeddingModels: string[];
};

async function fetchOpenAICompatibleModelIds(input: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/models`;
  const response = await ofetch<{ data?: Array<{ id?: unknown }> }>(url, {
    headers: {
      ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      ...input.headers,
    },
    timeout: 10_000,
  });

  return (response.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Fetch the live model list from an OpenAI-compatible provider's
 * `GET /models` endpoint. Used by the admin models form to surface models
 * that the static models.dev catalog doesn't know about (custom/self-hosted
 * endpoints, embedding-only servers, ...). Admin-only because it makes the
 * server issue an authenticated request to an admin-supplied URL.
 */
export async function listProviderModelsAction(input: {
  base_url: string;
  api_key?: string;
  headers?: Record<string, string>;
  embedding_base_url?: string;
}): Promise<ProviderModelListResponse> {
  const cookieStore = await cookies();
  await requireAdminAccess(cookieStore);

  // The primary base_url query is authoritative: its failure rejects the
  // action. The optional embedding_base_url query degrades to an empty list
  // so a dead embedding endpoint can't hide the successfully fetched
  // primary models.
  const [modelsResult, embeddingResult] = await Promise.allSettled([
    fetchOpenAICompatibleModelIds({
      baseUrl: input.base_url,
      apiKey: input.api_key,
      headers: input.headers,
    }),
    input.embedding_base_url
      ? fetchOpenAICompatibleModelIds({
          baseUrl: input.embedding_base_url,
          apiKey: input.api_key,
          headers: input.headers,
        })
      : Promise.resolve([]),
  ]);

  if (modelsResult.status === 'rejected') {
    throw modelsResult.reason;
  }
  if (embeddingResult.status === 'rejected') {
    logger.warn(
      'embedding_base_url model fetch failed; continuing without it',
      {
        embeddingBaseUrl: input.embedding_base_url,
        error:
          embeddingResult.reason instanceof Error
            ? embeddingResult.reason.message
            : String(embeddingResult.reason),
      },
    );
  }

  return {
    models: modelsResult.value,
    embeddingModels:
      embeddingResult.status === 'fulfilled' ? embeddingResult.value : [],
  };
}

export async function getImPairStatusAction(adapter: AdapterName): Promise<{
  paired: boolean;
  imUserId: string | null;
  imUserName: string | null;
  pairedAt: string | null;
}> {
  const access = await requireAuth();
  const accounts = await listImAccountsForUser(access.session.userId);
  const account = accounts.find((a) => a.adapter === adapter);
  if (!account || account.unpairedAt) {
    return { paired: false, imUserId: null, imUserName: null, pairedAt: null };
  }
  return {
    paired: true,
    imUserId: account.imUserId,
    imUserName: account.imUserName,
    pairedAt: account.pairedAt.toISOString(),
  };
}

export async function unpairImAccountAction(
  adapter: AdapterName,
): Promise<{ ok: boolean }> {
  const access = await requireAuth();
  const removed = await unpairImAccountByClawlessUser({
    clawlessUserId: access.session.userId,
    adapter,
  });
  return { ok: removed };
}

// ---- Per-user model preferences ----

export async function getUserModelPreferencesAction(): Promise<{
  model: string | null;
  globalDefault: string | null;
  allowedModels: string[] | null;
}> {
  const access = await requireAuth();
  const [user, config] = await Promise.all([
    getUserById(access.session.userId),
    getConfig(),
  ]);
  return {
    model: user?.modelPreferences?.model ?? null,
    globalDefault: config.models?.model ?? null,
    // null = admin has not set a catalog; the client falls back to
    // the full configured-provider model list. An empty array would
    // be ambiguous with "no catalog", so we normalize both to null.
    allowedModels: (() => {
      const catalogKeys = Object.keys(config.models?.model_catalog ?? {});
      return catalogKeys.length > 0 ? catalogKeys : null;
    })(),
  };
}
