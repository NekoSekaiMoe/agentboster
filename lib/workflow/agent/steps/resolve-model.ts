import { parseProviderScopedModelId, resolveLanguageModel } from '@/lib/ai';
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

  // Third-party OpenAI-compatible endpoints are now routed to Chat
  // Completions API (see resolveLanguageModel), so store:false doesn't
  // apply. Only return it for the official OpenAI Responses API, where
  // it prevents multi-step tool-loop replay issues.
  const baseUrl = providerConfig.base_url ?? '';
  const isOfficialOpenAI =
    !baseUrl ||
    baseUrl.replace(/\/+$/, '').toLowerCase() ===
      'https://api.openai.com/v1' ||
    baseUrl.replace(/\/+$/, '').toLowerCase() === 'https://api.openai.com';

  if (!isOfficialOpenAI) {
    return undefined;
  }

  return { openai: { store: false } };
}
