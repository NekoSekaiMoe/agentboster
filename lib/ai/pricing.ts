/**
 * Per-model token pricing + cost calculation.
 *
 * Inspired by AutoGPT's `cost_tracking.py::resolve_tracking` +
 * `anthropic_rate_card.json`: separate USD cost from internal credit,
 * and let any caller compute the USD cost of a TokenUsage record without
 * a DB round-trip.
 *
 * agentboster adaptation:
 * - No persisted credit system (yet). This module is read-only: it
 *   computes cost from a static rate card. The result can be surfaced
 *   in UI/logs, or attached to a session's metadata by the caller.
 * - The rate card is intentionally tiny and hand-maintained. A full
 *   provider pricing sync is out of scope for P1; missing models fall
 *   back to null cost rather than guessing.
 *
 * Pricing units: USD per 1,000,000 tokens (the convention providers
 * publish). Divide by 1e6 when multiplying by token counts.
 */

import type { TokenUsage } from '@/lib/workflow/agent/types';
import { getTokenUsageTotal } from '@/lib/workflow/agent/types';

/**
 * Per-model price tier.
 *
 * `input` / `output` are USD per 1M tokens. `cacheRead` (when present)
 * is typically 10-20% of input; providers bill it separately.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
}

/**
 * Hand-maintained rate card. Update when providers change pricing; the
 * values are public list prices in USD per 1M tokens.
 *
 * Keys are matched as prefixes against the model id, so 'gpt-4o' covers
 * 'gpt-4o-2024-11-20' etc. The longest matching prefix wins.
 */
const RATE_CARD: Record<string, ModelPricing> = {
  // OpenAI — https://openai.com/api/pricing/
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  o3: { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Anthropic — https://www.anthropic.com/pricing
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 1, output: 5 },
  'claude-opus-4': { input: 15, output: 75 },
  // Google — https://ai.google.dev/pricing
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

/**
 * Resolve pricing for a model id. Returns the longest-prefix match in
 * the rate card, or null when the model is unknown. Longest-prefix so
 * 'claude-sonnet-4' wins over 'claude' if both were keys.
 */
export function resolveModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  // Normalize to lowercase for matching; provider casing varies.
  const lower = modelId.toLowerCase();
  let best: { key: string; pricing: ModelPricing } | null = null;
  for (const [key, pricing] of Object.entries(RATE_CARD)) {
    if (lower.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, pricing };
    }
  }
  return best?.pricing ?? null;
}

/**
 * Compute the USD cost of a TokenUsage record for a given model.
 *
 * Returns null when either the model is unknown or the usage record has
 * no token counts. The caller decides how to surface "cost unknown"
 * (typically a dash in the UI rather than $0.00, to avoid implying free).
 *
 * @param modelId The model id used for the call (e.g. 'claude-sonnet-4-20250514').
 * @param usage   The TokenUsage record from the AI SDK step callback.
 */
export function computeUsageCost(
  modelId: string,
  usage: TokenUsage,
): { costUsd: number; inputTokens: number; outputTokens: number } | null {
  const pricing = resolveModelPricing(modelId);
  if (!pricing) return null;

  const inputTokens = getTokenUsageTotal(usage.inputTokens);
  const outputTokens = getTokenUsageTotal(usage.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;

  // USD per 1M tokens → multiply by (tokens / 1e6).
  const inputCost = (inputTokens / 1e6) * pricing.input;
  const outputCost = (outputTokens / 1e6) * pricing.output;
  return {
    costUsd: Number((inputCost + outputCost).toFixed(6)),
    inputTokens,
    outputTokens,
  };
}

/**
 * Register a custom pricing entry at runtime. Lets extensions / config
 * add provider-specific rates without forking the rate card.
 *
 * The override is merged into the module-level card; prefer using a
 * unique key that won't collide with future built-in entries.
 */
export function registerModelPricing(
  modelPrefix: string,
  pricing: ModelPricing,
): void {
  RATE_CARD[modelPrefix.toLowerCase()] = pricing;
}
