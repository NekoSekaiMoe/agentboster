export interface ProviderPreset {
  label: string;
  format: 'openaicompatible' | 'anthropic' | 'openai' | 'google';
  base_url: string;
  default_models: string[];
  description: string;
  /**
   * Which OpenAI-style API endpoint to use when format === 'openai'.
   * - 'responses' : /v1/responses (OpenAI's newer API, supports server-side
   *                 state, reasoning persistence, etc.)
   * - 'chat'      : /v1/chat/completions (the classic endpoint, universally
   *                 supported by all OpenAI-compatible providers)
   * - 'auto'      : decide at runtime — 'responses' for the official OpenAI
   *                 base_url, 'chat' for everything else (default)
   *
   * Ignored when format !== 'openai'.
   */
  openai_api?: 'responses' | 'chat' | 'auto';
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    format: 'openai',
    base_url: 'https://api.openai.com/v1',
    default_models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    description: 'OpenAI official API',
    openai_api: 'responses',
  },
  anthropic: {
    label: 'Anthropic',
    format: 'anthropic',
    base_url: 'https://api.anthropic.com',
    default_models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250514',
      'claude-opus-4-20250514',
    ],
    description: 'Anthropic Claude API',
  },
  deepseek: {
    label: 'DeepSeek',
    format: 'openaicompatible',
    base_url: 'https://api.deepseek.com/v1',
    default_models: ['deepseek-chat', 'deepseek-reasoner'],
    description: 'DeepSeek API (OpenAI-compatible)',
  },
  ollama: {
    label: 'Ollama',
    format: 'openaicompatible',
    base_url: 'http://127.0.0.1:11434/v1',
    default_models: [],
    description: 'Local Ollama server — models are auto-detected',
  },
  openrouter: {
    label: 'OpenRouter',
    format: 'openaicompatible',
    base_url: 'https://openrouter.ai/api/v1',
    default_models: [
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'deepseek/deepseek-chat',
    ],
    description: 'OpenRouter multi-model gateway',
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    format: 'openaicompatible',
    base_url: 'https://api.moonshot.cn/v1',
    default_models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    description: 'Moonshot Kimi API (OpenAI-compatible)',
  },
  qwen: {
    label: 'Qwen (DashScope)',
    format: 'openaicompatible',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    description: 'Alibaba Cloud DashScope Qwen API (OpenAI-compatible)',
  },
  groq: {
    label: 'Groq',
    format: 'openaicompatible',
    base_url: 'https://api.groq.com/openai/v1',
    default_models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
    description: 'Groq fast inference API (OpenAI-compatible)',
  },
};

export const PRESET_LIST = Object.entries(PROVIDER_PRESETS).map(
  ([key, preset]) => ({
    value: key,
    ...preset,
  }),
);

export function getPreset(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[key];
}

export function applyPresetToConfig(
  presetKey: string,
  existingConfig: {
    format?: string;
    base_url?: string;
    api_key?: string;
    headers?: Record<string, string>;
  },
): {
  format: string;
  base_url: string;
  api_key?: string;
  headers?: Record<string, string>;
  preset: string;
} {
  const preset = PROVIDER_PRESETS[presetKey];
  if (!preset) {
    return {
      ...existingConfig,
      format: existingConfig.format || 'openaicompatible',
      base_url: existingConfig.base_url || '',
      preset: presetKey,
    };
  }
  return {
    format: preset.format,
    base_url: preset.base_url,
    api_key: existingConfig.api_key,
    headers: existingConfig.headers,
    preset: presetKey,
  };
}
