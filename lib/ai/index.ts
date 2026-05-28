import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import { embed } from 'ai';
import { getEmbeddingModel, getLanguageModel, getProvider } from './providers';

type ParsedModelId =
  | { providerName: string; providerModelId: string }
  | { providerName: null; providerModelId: string };

/**
 * Parse a model ID into provider name and model ID.
 *
 * - Scoped: "provider/model-id" -> { providerName: "provider", providerModelId: "model-id" }
 * - Bare: "model-id" -> { providerName: null, providerModelId: "model-id" }
 *   (resolved against the first configured provider at the call site)
 */
export function parseProviderScopedModelId(modelId: string): ParsedModelId {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error('Model ID must not be empty');
  }

  const separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { providerName: null, providerModelId: trimmed };
  }

  return {
    providerName: trimmed.slice(0, separatorIndex),
    providerModelId: trimmed.slice(separatorIndex + 1),
  };
}

function resolveProviderEntry(
  parsed: ParsedModelId,
  config: AppConfig,
  modelId: string,
): { providerName: string; providerModelId: string } {
  const logger = createLogger('ai.model');
  const providers = config.models?.providers ?? {};
  const providerKeys = Object.keys(providers);

  if (parsed.providerName !== null) {
    if (!providers[parsed.providerName]) {
      logger.error('resolve:provider_not_found', {
        modelId,
        providerName: parsed.providerName,
        configuredProviders: providerKeys,
      });
      throw new Error(
        `Provider "${parsed.providerName}" not found in configuration`,
      );
    }
    return {
      providerName: parsed.providerName,
      providerModelId: parsed.providerModelId,
    };
  }

  if (providerKeys.length === 0) {
    throw new Error(
      `No providers configured. Add a provider in Config > Models, or use the scoped format "provider/${parsed.providerModelId}".`,
    );
  }

  const fallbackProvider = providerKeys[0];
  logger.info('resolve:using_fallback_provider', {
    modelId,
    fallbackProvider,
  });

  return {
    providerName: fallbackProvider,
    providerModelId: parsed.providerModelId,
  };
}

export function resolveLanguageModel(modelId: string, config: AppConfig) {
  const logger = createLogger('ai.model');
  const parsed = parseProviderScopedModelId(modelId);
  const { providerName, providerModelId } = resolveProviderEntry(
    parsed,
    config,
    modelId,
  );

  const providerConfig = config.models?.providers?.[providerName];
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" not found in configuration`);
  }

  logger.info('resolve:language_model', {
    modelId,
    providerName,
    providerModelId,
    providerFormat: providerConfig.format,
  });

  const provider = getProvider({
    provider: providerName,
    format: providerConfig.format,
    api_key: providerConfig.api_key,
    base_url: providerConfig.base_url,
    headers: providerConfig.headers,
  });

  return getLanguageModel(providerModelId, provider);
}

export function resolveEmbeddingModel(modelId: string, config: AppConfig) {
  const logger = createLogger('ai.model');
  const parsed = parseProviderScopedModelId(modelId);
  const { providerName, providerModelId } = resolveProviderEntry(
    parsed,
    config,
    modelId,
  );

  const providerConfig = config.models?.providers?.[providerName];
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" not found in configuration`);
  }

  logger.info('resolve:embedding_model', {
    modelId,
    providerName,
    providerModelId,
    providerFormat: providerConfig.format,
  });

  const provider = getProvider({
    provider: providerName,
    format: providerConfig.format,
    api_key: providerConfig.api_key,
    base_url: providerConfig.base_url,
    headers: providerConfig.headers,
  });

  return getEmbeddingModel(providerModelId, provider);
}

export async function generateEmbedding(
  value: string,
  modelId: string,
  config: AppConfig,
) {
  const { embedding } = await embed({
    model: resolveEmbeddingModel(modelId, config),
    value,
  });

  return {
    embedding,
    embeddingModel: modelId,
    embeddingDimensions: embedding.length,
  };
}
