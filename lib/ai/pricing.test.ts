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

  it('returns the precise raw cost without rounding', () => {
    const result = computeUsageCost('gemini-2.5-flash', {
      inputTokens: 3,
      outputTokens: 7,
    });
    expect(result).not.toBeNull();
    // 3/1e6 * 0.3 + 7/1e6 * 2.5 = 0.0000009 + 0.0000175 = 0.0000184
    // Precise sum, no toFixed rounding.
    expect(result?.costUsd).toBeCloseTo(0.0000184, 10);
  });

  it('applies Gemini 2.5 Pro token-threshold pricing across the 200k boundary', () => {
    // Exactly at/under 200k → low tier ($1.25/$10).
    const under = computeUsageCost('gemini-2.5-pro', {
      inputTokens: 200_000,
      outputTokens: 0,
    });
    expect(under?.costUsd).toBeCloseTo((200_000 / 1e6) * 1.25, 10);

    // 200_001 input tokens → crosses into the high tier ($2.50/$15) for
    // the WHOLE request (tiered pricing is per-request, not blended).
    const over = computeUsageCost('gemini-2.5-pro', {
      inputTokens: 200_001,
      outputTokens: 0,
    });
    expect(over?.costUsd).toBeCloseTo((200_001 / 1e6) * 2.5, 10);
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

  it('rejects blank or whitespace-only prefixes', () => {
    expect(() => registerModelPricing('   ', { input: 1, output: 2 })).toThrow(
      /non-empty/,
    );
    expect(() => registerModelPricing('', { input: 1, output: 2 })).toThrow(
      /non-empty/,
    );
  });

  it('rejects negative, NaN, or infinite flat rates', () => {
    expect(() =>
      registerModelPricing('bad-neg', { input: -1, output: 2 }),
    ).toThrow(/input/);
    expect(() =>
      registerModelPricing('bad-nan', { input: Number.NaN, output: 2 }),
    ).toThrow(/input/);
    expect(() =>
      registerModelPricing('bad-inf', {
        input: 1,
        output: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/output/);
    expect(() =>
      registerModelPricing('bad-cache', {
        input: 1,
        output: 2,
        cacheRead: -0.1,
      }),
    ).toThrow(/cacheRead/);
  });

  it('rejects invalid rates inside tiers', () => {
    expect(() =>
      registerModelPricing('bad-tier', {
        input: 1,
        output: 2,
        tiers: [{ threshold: 0, input: -5, output: 1 }],
      }),
    ).toThrow(/tiers\[0\]\.input/);
  });

  it('rejects non-integer / negative / non-finite tier thresholds', () => {
    expect(() =>
      registerModelPricing('bad-thresh-neg', {
        input: 1,
        output: 2,
        tiers: [{ threshold: -1, input: 1, output: 2 }],
      }),
    ).toThrow(/tiers\[0\]\.threshold/);
    expect(() =>
      registerModelPricing('bad-thresh-frac', {
        input: 1,
        output: 2,
        tiers: [{ threshold: 0.5, input: 1, output: 2 }],
      }),
    ).toThrow(/tiers\[0\]\.threshold/);
    expect(() =>
      registerModelPricing('bad-thresh-nan', {
        input: 1,
        output: 2,
        tiers: [{ threshold: Number.NaN, input: 1, output: 2 }],
      }),
    ).toThrow(/tiers\[0\]\.threshold/);
  });

  it('rejects tiers that are not in strictly increasing threshold order', () => {
    // 100 followed by 0 — would silently select the wrong bracket under
    // resolveTieredPricing's "highest applicable threshold wins" rule.
    expect(() =>
      registerModelPricing('bad-order', {
        input: 1,
        output: 2,
        tiers: [
          { threshold: 100, input: 1, output: 2 },
          { threshold: 0, input: 2, output: 4 },
        ],
      }),
    ).toThrow(/strictly increasing/);
    // Equal thresholds are also rejected (strictly increasing, not non-decreasing).
    expect(() =>
      registerModelPricing('bad-order-equal', {
        input: 1,
        output: 2,
        tiers: [
          { threshold: 0, input: 1, output: 2 },
          { threshold: 0, input: 2, output: 4 },
        ],
      }),
    ).toThrow(/strictly increasing/);
  });

  it('normalizes the stored prefix to trimmed + lowercase', () => {
    // Register with surrounding whitespace + mixed case; resolution must
    // still find it via a clean lowercased model id.
    registerModelPricing('  Trim-Sample-Model  ', {
      input: 1,
      output: 2,
    });
    expect(resolveModelPricing('trim-sample-model-v2')).not.toBeNull();
    const cost = computeUsageCost('trim-sample-model-v2', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost?.costUsd).toBe(1);
  });
});
