const MODEL_CONTEXT_SIZES: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_384,
  o1: 200_000,
  'o1-mini': 128_000,
  'o1-pro': 200_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
  'deepseek-v3': 65_536,
  'deepseek-r1': 65_536,
  'qwen-max': 32_768,
  'qwen-plus': 131_072,
  'qwen-turbo': 131_072,
  'qwen3-235b-a22b': 131_072,
  'llama-4-maverick': 1_048_576,
  'llama-4-scout': 10_485_760,
  'llama-3.1-405b': 131_072,
  'llama-3.1-70b': 131_072,
  'llama-3.1-8b': 131_072,
  'mistral-large': 131_072,
  'mistral-medium': 32_768,
  'mistral-small': 32_768,
  'mixtral-8x7b': 32_768,
  'command-r-plus': 131_072,
  'command-r': 131_072,
};

export function resolveModelContextLimit(
  modelId: string,
  configuredLimit: number | undefined,
): number {
  if (configuredLimit && configuredLimit > 0) {
    return configuredLimit;
  }

  const normalizedId = modelId.toLowerCase().trim();

  if (MODEL_CONTEXT_SIZES[normalizedId]) {
    return MODEL_CONTEXT_SIZES[normalizedId];
  }

  for (const [key, value] of Object.entries(MODEL_CONTEXT_SIZES)) {
    if (normalizedId.includes(key) || key.includes(normalizedId)) {
      return value;
    }
  }

  return 128_000;
}

export function resolveModelMaxOutputTokens(
  modelId: string,
  configuredMax: number | undefined,
): number {
  if (configuredMax && configuredMax > 0) {
    return configuredMax;
  }

  const normalizedId = modelId.toLowerCase().trim();

  if (
    normalizedId.includes('o1') ||
    normalizedId.includes('o3') ||
    normalizedId.includes('o4')
  ) {
    return 32_000;
  }
  if (
    normalizedId.includes('gemini-1.5') ||
    normalizedId.includes('gemini-2.5')
  ) {
    return 8_192;
  }
  if (normalizedId.includes('claude')) {
    return 8_192;
  }
  if (normalizedId.includes('deepseek')) {
    return 8_192;
  }

  return 4_096;
}
