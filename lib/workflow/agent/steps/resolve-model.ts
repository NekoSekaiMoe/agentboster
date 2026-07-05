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
  /**
   * Thinking level forwarded by the CLI `/effort` command. When set and
   * supported by the resolved provider format, serialized into the
   * matching provider-specific reasoning field:
   *   - OpenAI Responses API (format='openai'): `reasoningEffort`
   *     (minimal/low/medium/high; xhigh maps to high).
   *   - Anthropic (format='anthropic'): `thinking.budgetTokens` mapped
   *     from the level (off→disabled, minimal→1k, low→4k, medium→8k,
   *     high→16k, xhigh→32k).
   *   - Google (format='google'): `thinkingConfig.thinkingBudget` with
   *     the same token mapping as Anthropic.
   *   - openaicompatible (DeepSeek, Ollama, etc.): NOT injected. These
   *     vary too much (DeepSeek uses enable_thinking header, Ollama has
   *     its own per-model flag). Users wanting thinking on those should
   *     configure provider options at the provider level.
   * 'off' / undefined: no reasoning field is sent; the provider's
   * default behavior applies.
   */
  thinkingLevel?: string,
): Promise<ProviderOptions | undefined> {
  'use step';

  const providers = config.models?.providers ?? {};
  const parsed = parseProviderScopedModelId(modelId);
  const providerName = parsed.providerName ?? Object.keys(providers)[0];
  const providerConfig = providerName ? providers[providerName] : undefined;
  if (!providerConfig) {
    return undefined;
  }

  const format = providerConfig.format;
  const level = normalizeThinkingLevel(thinkingLevel);

  if (format === 'openai') {
    // Responses API carries reasoning via reasoningEffort. Chat API has
    // no equivalent — it silently ignores the field, so only set it when
    // actually routing to /v1/responses.
    const openaiOpts: Record<string, string | boolean> = {};
    if (usesResponsesApi(providerConfig)) {
      openaiOpts.store = false;
      if (level && level !== 'off') {
        // xhigh has no OpenAI equivalent; clamp to high.
        openaiOpts.reasoningEffort = level === 'xhigh' ? 'high' : level;
      }
    }
    return Object.keys(openaiOpts).length > 0
      ? ({ openai: openaiOpts } as ProviderOptions)
      : undefined;
  }

  if (format === 'anthropic' && level && level !== 'off') {
    const budget = THINKING_BUDGET_TOKENS[level];
    if (budget > 0) {
      return {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: budget },
        },
      };
    }
    return undefined;
  }

  if (format === 'google' && level && level !== 'off') {
    const budget = THINKING_BUDGET_TOKENS[level];
    if (budget > 0) {
      return {
        google: { thinkingConfig: { thinkingBudget: budget } },
      };
    }
    return undefined;
  }

  return undefined;
}

type NormalizedThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

function normalizeThinkingLevel(
  value: string | undefined,
): NormalizedThinkingLevel | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  const valid: NormalizedThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ];
  return valid.includes(lower as NormalizedThinkingLevel)
    ? (lower as NormalizedThinkingLevel)
    : undefined;
}

// Token-budget mapping for Anthropic / Google thinking. OpenAI uses
// named levels (minimal/low/medium/high) and is handled inline.
const THINKING_BUDGET_TOKENS: Record<
  Exclude<NormalizedThinkingLevel, 'off'>,
  number
> = {
  minimal: 1_024,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
};

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
  client_spoof?: string;
}): boolean {
  if (providerConfig.format !== 'openai') {
    return false;
  }

  // NOTE: client_spoof no longer forces the Responses API. A 'codex' spoof
  // follows the resolved API mode; see getEffectiveProviderClientSpoof's
  // openaiApi handling. On OpenAI Legacy (Chat Completions) the spoof is
  // dropped, so legacy endpoints are never impersonated as Codex.

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
