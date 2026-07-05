import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { AIProviderConfig } from '@/types/config/ai';
import { embed } from 'ai';
import {
  getEmbeddingModel,
  getLanguageModel,
  getProvider,
  getSpeechModel,
} from './providers';
import { getPreset } from './presets';

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

  // Decide whether to use the Responses API or Chat Completions API.
  // Only relevant when format === 'openai' — other formats use their
  // provider's native API surface.
  const useChatApi = shouldUseChatApi(providerConfig);

  logger.info('resolve:language_model', {
    modelId,
    providerName,
    providerModelId,
    providerFormat: providerConfig.format,
    useChatApi,
  });

  const provider = getProvider({
    provider: providerName,
    format: providerConfig.format,
    api_key: providerConfig.api_key,
    base_url: providerConfig.base_url,
    headers: providerConfig.headers,
    client_spoof: providerConfig.client_spoof,
    openai_api:
      providerConfig.format === 'openai'
        ? useChatApi
          ? 'chat'
          : 'responses'
        : undefined,
  });

  return getLanguageModel(providerModelId, provider, useChatApi);
}

/**
 * Decide whether to force Chat Completions API for an OpenAI-format provider.
 *
 * The @ai-sdk/openai provider function defaults to the Responses API
 * (/v1/responses). Most third-party OpenAI-compatible endpoints only
 * implement Chat Completions (/v1/chat/completions), so sending them
 * Responses-format requests produces malformed tool_calls and breaks
 * all agent tool loops.
 *
 * Resolution order:
 *   1. Explicit `openai_api` in provider config ('responses' | 'chat' | 'auto')
 *   2. Preset's `openai_api` value, if a preset is set
 *   3. 'auto' default: 'responses' for the official OpenAI base_url,
 *      'chat' for everything else
 *
 * Returns false (use provider default = Responses API) only when the
 * caller explicitly opts in via 'responses' or when auto-detection
 * concludes the endpoint is the official OpenAI API.
 */
function shouldUseChatApi(providerConfig: AIProviderConfig): boolean {
  if (providerConfig?.format !== 'openai') {
    return false;
  }

  // NOTE: client_spoof no longer forces the Responses API. A 'codex' spoof
  // only applies when the endpoint actually resolves to Responses (see
  // resolveLanguageModel's openai_api wiring); on OpenAI Legacy (Chat
  // Completions) the spoof is dropped, so legacy endpoints stay honest.

  const choice = providerConfig.openai_api ?? 'auto';

  if (choice === 'responses') {
    return false;
  }
  if (choice === 'chat') {
    return true;
  }

  // 'auto': check preset first, then fall back to base_url detection.
  const presetKey = providerConfig.preset;
  if (presetKey) {
    const preset = getPreset(presetKey);
    if (preset?.openai_api === 'chat') {
      return true;
    }
    if (preset?.openai_api === 'responses') {
      return false;
    }
  }

  // No explicit signal — detect by base_url.
  const baseUrl = providerConfig.base_url ?? '';
  return !isOfficialOpenAIBaseUrl(baseUrl);
}

/**
 * Check whether a base_url points to the official OpenAI API.
 * Used as the 'auto' fallback when neither the provider config nor
 * the preset explicitly declares openai_api.
 */
function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return true; // default base_url is api.openai.com
  }
  const normalized = baseUrl.toLowerCase().replace(/\/+$/, '');
  return (
    normalized === 'https://api.openai.com/v1' ||
    normalized === 'https://api.openai.com'
  );
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
    client_spoof: providerConfig.client_spoof,
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

/**
 * Resolve a SpeechModel from a model ID + AppConfig.
 *
 * Mirrors resolveEmbeddingModel's structure but routes through
 * getSpeechModel, which throws if the resolved provider is not OpenAI.
 * TTS only supports OpenAI's speech() API today.
 */
export function resolveSpeechModel(modelId: string, config: AppConfig) {
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

  if (providerConfig.format !== 'openai') {
    logger.error('resolve:speech_provider_unsupported', {
      modelId,
      providerName,
      providerFormat: providerConfig.format,
    });
    throw new Error(
      `TTS currently supports OpenAI-format providers only (got format "${providerConfig.format}" for provider "${providerName}").`,
    );
  }

  logger.info('resolve:speech_model', {
    modelId,
    providerName,
    providerModelId,
  });

  const provider = getProvider({
    provider: providerName,
    format: providerConfig.format,
    api_key: providerConfig.api_key,
    base_url: providerConfig.base_url,
    headers: providerConfig.headers,
    client_spoof: providerConfig.client_spoof,
  });

  return getSpeechModel(providerModelId, provider);
}
