import { parseProviderScopedModelId, resolveLanguageModel } from '@/lib/ai';
import { getPreset } from '@/lib/ai/presets';
import type { AppConfig } from '@/types/config';
import type {
  CompatibleLanguageModel,
  ProviderOptions,
} from '@workflow/ai/agent';

export function createModelResolver(config: AppConfig, modelId: string) {
  return async function resolveModel(): Promise<CompatibleLanguageModel> {
    'use step';

    return resolveLanguageModel(modelId, config) as CompatibleLanguageModel;
  };
}

export async function resolveAgentProviderOptions(
  config: AppConfig,
  modelId: string,
): Promise<ProviderOptions | undefined> {
  'use step';

  const providers = config.models?.providers ?? {};
  const parsed = parseProviderScopedModelId(modelId);
  const providerName = parsed.providerName ?? Object.keys(providers)[0];
  const providerConfig = providerName ? providers[providerName] : undefined;

  if (providerConfig?.format !== 'openai') {
    return undefined;
  }

  // store:false is a Responses-API-specific workaround for multi-step
  // local tool loops. It's meaningless for Chat Completions API.
  // Only return it when the provider actually uses the Responses API.
  if (!usesResponsesApi(providerConfig)) {
    return undefined;
  }

  return { openai: { store: false } };
}

/**
 * Determine whether this provider configuration routes to the OpenAI
 * Responses API (/v1/responses). Mirrors the logic in resolveLanguageModel's
 * shouldUseChatApi so providerOptions stay consistent with the actual
 * HTTP endpoint being called.
 */
function usesResponsesApi(providerConfig: {
  format?: string;
  openai_api?: string;
  preset?: string;
  base_url?: string;
}): boolean {
  if (providerConfig.format !== 'openai') {
    return false;
  }

  const choice = providerConfig.openai_api ?? 'auto';

  if (choice === 'responses') {
    return true;
  }
  if (choice === 'chat') {
    return false;
  }

  // 'auto': check preset first, then fall back to base_url detection.
  if (providerConfig.preset) {
    const preset = getPreset(providerConfig.preset);
    if (preset?.openai_api === 'responses') {
      return true;
    }
    if (preset?.openai_api === 'chat') {
      return false;
    }
  }

  const baseUrl = providerConfig.base_url ?? '';
  const normalized = baseUrl.toLowerCase().replace(/\/+$/, '');
  return (
    normalized === 'https://api.openai.com/v1' ||
    normalized === 'https://api.openai.com' ||
    normalized === ''
  );
}
