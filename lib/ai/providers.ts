import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { experimental_generateSpeech as experimental_generateSpeechImport } from 'ai';
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

/**
 * Resolve a SpeechModel from a provider instance.
 *
 * TTS today only works against the OpenAI provider's speech() method
 * (tts-1 / tts-1-hd / gpt-4o-mini-tts). Other provider formats
 * (anthropic, google, openaicompatible) do not currently expose a
 * stable SpeechModel in this codebase, so we throw rather than silently
 * producing a runtime "speech is not a function" error.
 *
 * The error message is intentionally actionable so the user knows to
 * reconfigure tts.model to point at an OpenAI provider.
 */
export function getSpeechModel(
  model: string,
  provider: ReturnType<typeof getProvider>,
): SpeechModelLike {
  const maybeOpenAI = provider as unknown as {
    speech?: (id: string) => SpeechModelLike;
  };
  if (typeof maybeOpenAI.speech !== 'function') {
    throw new Error(
      'TTS currently supports the OpenAI provider only. Configure tts.model to route to an OpenAI provider (format: "openai").',
    );
  }
  return maybeOpenAI.speech(model);
}

// Minimal structural type for a speech model. Avoids importing the full
// SpeechModel from 'ai' into this low-level provider module just for a
// type cast — the SDK runtime check is what actually matters.
type SpeechModelLike = Parameters<
  typeof experimental_generateSpeechImport
>[0]['model'];
