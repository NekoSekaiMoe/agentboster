import { describe, expect, it } from 'vitest';

import {
  computeUsageCost,
  registerModelPricing,
  resolveModelPricing,
} from './pricing';

describe('resolveModelPricing', () => {
  it('matches by case-insensitive prefix', () => {
    expect(resolveModelPricing('claude-sonnet-4-20250514')).not.toBeNull();
    expect(resolveModelPricing('CLAUDE-SONNET-4')).not.toBeNull();
    expect(resolveModelPricing('GPT-4o-mini')).not.toBeNull();
  });

  it('picks the longest matching prefix', () => {
    // Both 'gpt-4o' and 'gpt-4o-mini' are keys; the more specific one wins.
    const mini = resolveModelPricing('gpt-4o-mini-2024-07-18');
    expect(mini).not.toBeNull();
    expect(mini?.input).toBe(0.15);
  });

  it('returns null for unknown models', () => {
    expect(resolveModelPricing('some-fictional-model')).toBeNull();
    expect(resolveModelPricing('')).toBeNull();
  });
});

describe('computeUsageCost', () => {
  it('computes USD cost from token counts + rate card', () => {
    const result = computeUsageCost('claude-sonnet-4', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(result).not.toBeNull();
    // 1M input * $3 + 0.5M output * $15 = 3 + 7.5 = 10.5
    expect(result?.costUsd).toBe(10.5);
    expect(result?.inputTokens).toBe(1_000_000);
    expect(result?.outputTokens).toBe(500_000);
  });

  it('handles bucket-form token counts (extracts .total)', () => {
    const result = computeUsageCost('gpt-4o', {
      inputTokens: { total: 1_000_000 },
      outputTokens: { total: 1_000_000 },
    });
    expect(result?.costUsd).toBe(12.5); // 2.5 + 10
  });

  it('returns null when the model is unknown', () => {
    expect(
      computeUsageCost('unknown-model', {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeNull();
  });

  it('returns null when usage has no token counts', () => {
    expect(computeUsageCost('gpt-4o', {})).toBeNull();
    expect(
      computeUsageCost('gpt-4o', { inputTokens: 0, outputTokens: 0 }),
    ).toBeNull();
  });

  it('rounds cost to 6 decimal places to avoid float noise', () => {
    const result = computeUsageCost('gemini-2.5-flash', {
      inputTokens: 3,
      outputTokens: 7,
    });
    expect(result).not.toBeNull();
    // Tiny cost — verify it's a finite number with <= 6 decimals.
    expect(Number.isFinite(result?.costUsd)).toBe(true);
    const decimals = result?.costUsd.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

describe('registerModelPricing', () => {
  it('adds a custom rate that resolveModelPricing then finds', () => {
    registerModelPricing('custom-fancy-model', { input: 1, output: 2 });
    expect(resolveModelPricing('custom-fancy-model-v1')).not.toBeNull();
    const cost = computeUsageCost('custom-fancy-model-v1', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost?.costUsd).toBe(1);
  });
});
