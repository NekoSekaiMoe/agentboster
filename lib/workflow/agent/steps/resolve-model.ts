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

  // OpenAI Responses HTTP can reject multi-step local tool loops when stored
  // item references and function_call_output are replayed together.
  return { openai: { store: false } };
}
