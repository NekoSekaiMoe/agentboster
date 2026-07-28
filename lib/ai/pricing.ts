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
 * A pricing tier that applies above a token-count threshold.
 *
 * Some providers (notably Gemini 2.5 Pro) bill at different rates
 * depending on request size — e.g. ≤200k tokens at one rate, above at
 * a higher rate. `threshold` is the cumulative input-token count at/above
 * which the tier becomes active; the HIGHEST applicable threshold (i.e.
 * the last tier whose `threshold` is <= the request's input-token count)
 * is selected, so callers should list tiers in strictly increasing
 * threshold order. The base tier should carry `threshold: 0` so it acts
 * as the fallback when no higher bracket applies.
 */
export interface PricingTier {
  /**
   * Input-token count at/above which this tier applies. 0 = the base
   * (default) tier, always matched when no higher threshold applies.
   * Must be a finite, non-negative integer.
   */
  threshold: number;
  input: number;
  output: number;
  cacheRead?: number;
}

/**
 * Per-model pricing, either flat (single rate) or tiered by token count.
 *
 * `tiers` and the flat `input`/`output`/`cacheRead` fields are mutually
 * exclusive: when `tiers` is present it takes precedence and the flat
 * fields are ignored. This keeps the common single-rate case one-line
 * while still expressing stepped pricing.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  /**
   * Optional token-threshold tiers. When present, the tier with the
   * HIGHEST `threshold` that is <= the request's total input-token count
   * is selected (i.e. the topmost applicable bracket). List tiers in
   * strictly increasing threshold order, starting with the base rate
   * (`threshold: 0`) so it serves as the fallback.
   */
  tiers?: PricingTier[];
}

/**
 * Resolve the effective flat rates (input/output/cacheRead) for a model
 * at a given input-token count. Returns the longest-prefix match's
 * tier-aware rates, or null when the model is unknown.
 */
function resolveTieredPricing(
  pricing: ModelPricing,
  inputTokens: number,
): { input: number; output: number; cacheRead?: number } {
  if (pricing.tiers && pricing.tiers.length > 0) {
    // Tiers are evaluated lowest-threshold-first; pick the last tier
    // whose threshold is <= inputTokens (i.e. the highest applicable
    // bracket). Falls back to the lowest tier if none match (e.g.
    // inputTokens < first threshold, which shouldn't happen when the
    // base tier has threshold: 0).
    let match = pricing.tiers[0];
    for (const tier of pricing.tiers) {
      if (inputTokens >= tier.threshold) match = tier;
    }
    return match;
  }
  return pricing;
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
  // Gemini 2.5 Pro has token-threshold pricing: ≤200k tokens billed at
  // $1.25/$10, >200k at $2.50/$15. Tiers listed lowest-threshold-first
  // so resolveTieredPricing picks the right bracket.
  'gemini-2.5-pro': {
    input: 1.25,
    output: 10,
    tiers: [
      { threshold: 0, input: 1.25, output: 10 },
      { threshold: 200_001, input: 2.5, output: 15 },
    ],
  },
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

  // Resolve tiered pricing (no-op for flat-rate models) so stepped
  // pricing like Gemini 2.5 Pro's 200k-token breakpoint is applied.
  const tiered = resolveTieredPricing(pricing, inputTokens);

  // USD per 1M tokens → multiply by (tokens / 1e6). Return the raw sum
  // without fixed-precision rounding so callers/tests can assert exact
  // values; display layers can round for presentation.
  const inputCost = (inputTokens / 1e6) * tiered.input;
  const outputCost = (outputTokens / 1e6) * tiered.output;
  return {
    costUsd: inputCost + outputCost,
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
/**
 * Register a custom pricing entry at runtime. Lets extensions / config
 * add provider-specific rates without forking the rate card.
 *
 * Validation: rejects blank/whitespace-only prefixes and non-finite or
 * negative rates (NaN/Infinity would silently corrupt every cost
 * computation for that prefix). Throws on invalid input so misconfig
 * surfaces at registration time rather than as weird costs later.
 *
 * The override is merged into the module-level card; prefer using a
 * unique key that won't collide with future built-in entries.
 */
export function registerModelPricing(
  modelPrefix: string,
  pricing: ModelPricing,
): void {
  if (!modelPrefix?.trim()) {
    throw new Error(
      'registerModelPricing: modelPrefix must be a non-empty string',
    );
  }
  const validateRate = (value: number, field: string) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `registerModelPricing: ${field} must be a finite non-negative number (got ${value})`,
      );
    }
  };
  validateRate(pricing.input, 'input');
  validateRate(pricing.output, 'output');
  if (pricing.cacheRead !== undefined) {
    validateRate(pricing.cacheRead, 'cacheRead');
  }
  if (pricing.tiers) {
    let prevThreshold = -Infinity;
    for (const [i, tier] of pricing.tiers.entries()) {
      // Thresholds must be finite, non-negative integers. NaN/Infinity
      // would silently make a tier match every request (or none); a
      // fractional or negative threshold is meaningless for a token
      // count and usually a typo.
      if (
        !Number.isFinite(tier.threshold) ||
        tier.threshold < 0 ||
        !Number.isInteger(tier.threshold)
      ) {
        throw new Error(
          `registerModelPricing: tiers[${i}].threshold must be a finite non-negative integer (got ${tier.threshold})`,
        );
      }
      // Strictly increasing so resolveTieredPricing's "highest
      // applicable threshold wins" selection is unambiguous. An
      // unordered list (e.g. [100, 0]) would silently select the wrong
      // bracket — reject it at registration time rather than let it
      // corrupt cost math later.
      if (tier.threshold <= prevThreshold) {
        throw new Error(
          `registerModelPricing: tiers must be in strictly increasing threshold order (tiers[${i}].threshold=${tier.threshold} <= previous ${prevThreshold})`,
        );
      }
      prevThreshold = tier.threshold;
      validateRate(tier.input, `tiers[${i}].input`);
      validateRate(tier.output, `tiers[${i}].output`);
      if (tier.cacheRead !== undefined) {
        validateRate(tier.cacheRead, `tiers[${i}].cacheRead`);
      }
    }
  }
  // Normalize the stored key to trimmed + lowercase so a prefix
  // registered as '  GPT-4o  ' resolves identically to 'gpt-4o'.
  // resolveModelPricing lowercases the model id and does startsWith,
  // so any surrounding whitespace in the stored key would make it
  // effectively unmatchable.
  const normalizedPrefix = modelPrefix.trim().toLowerCase();
  RATE_CARD[normalizedPrefix] = pricing;
}
