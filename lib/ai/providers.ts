import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getPreset } from './presets';

type ProviderConfig = {
  provider?: string;
  format: 'openaicompatible' | 'anthropic' | 'openai' | 'google';
  api_key?: string;
  base_url?: string;
  headers?: Record<string, string>;
  preset?: string;
};

export function getProvider({
  provider,
  format: type,
  api_key,
  base_url,
  headers,
  preset: presetKey,
}: ProviderConfig) {
  // Apply preset defaults if a preset key is specified
  if (presetKey) {
    const preset = getPreset(presetKey);
    if (preset) {
      return getProvider({
        provider,
        format: preset.format as ProviderConfig['format'],
        api_key,
        base_url: preset.base_url,
        headers,
      });
    }
  }

  switch (type) {
    case 'openaicompatible': {
      return createOpenAICompatible({
        name: provider || 'openaicompatible',
        baseURL: base_url || 'https://api.openai.com/v1',
        apiKey: api_key,
        headers,
      });
    }
    case 'anthropic': {
      return createAnthropic({
        name: provider || 'anthropic',
        baseURL: base_url || 'https://api.anthropic.com/v1',
        apiKey: api_key,
        headers,
      });
    }
    case 'openai': {
      return createOpenAI({
        name: provider || 'openai',
        baseURL: base_url || 'https://api.openai.com/v1',
        apiKey: api_key,
        headers,
      });
    }
    case 'google': {
      return createGoogleGenerativeAI({
        name: provider || 'google',
        apiKey: api_key,
        headers,
      });
    }
    default: {
      const unsupportedType: never = type;
      throw new Error(`Unsupported model provider type: ${unsupportedType}`);
    }
  }
}

export function getLanguageModel(
  model: string,
  provider: ReturnType<typeof getProvider>,
  useChatApi = false,
) {
  // For OpenAI providers, the default provider() call routes to the
  // Responses API (/v1/responses). Third-party OpenAI-compatible endpoints
  // (e.g. GLM, DeepSeek) typically only implement Chat Completions
  // (/v1/chat/completions) and return malformed tool_calls when sent
  // Responses-format requests. When useChatApi is true, explicitly use
  // provider.chat() to force the Chat Completions API.
  if (useChatApi && 'chat' in provider && typeof provider.chat === 'function') {
    return provider.chat(model);
  }
  return provider(model);
}

export function getEmbeddingModel(
  model: string,
  provider: ReturnType<typeof getProvider>,
) {
  return provider.embeddingModel(model);
}
