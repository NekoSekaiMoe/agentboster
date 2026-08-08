/**
 * Tests for the SDK's pure token-usage helpers.
 *
 * subpackage/sdk is TypeScript source-only (no build step; jiti compiles
 * on load) and previously had NO tests. These two helpers are the only
 * runtime logic in the SDK's workflow types module — everything else is
 * type-only. They mirror lib/workflow/agent/types/index.ts and are the
 * public contract for consumers that import the SDK standalone.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateTokenUsage,
  getTokenUsageTotal,
} from './types';

describe('getTokenUsageTotal', () => {
  it('returns a finite number directly', () => {
    expect(getTokenUsageTotal(42)).toBe(42);
    expect(getTokenUsageTotal(0)).toBe(0);
  });

  it('returns 0 for NaN / Infinity', () => {
    expect(getTokenUsageTotal(Number.NaN)).toBe(0);
    expect(getTokenUsageTotal(Number.POSITIVE_INFINITY)).toBe(0);
    expect(getTokenUsageTotal(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('extracts .total from a bucket object', () => {
    expect(getTokenUsageTotal({ total: 100 })).toBe(100);
    expect(getTokenUsageTotal({ total: 0 })).toBe(0);
  });

  it('returns 0 for a bucket without a finite .total', () => {
    expect(getTokenUsageTotal({ total: undefined })).toBe(0);
    expect(getTokenUsageTotal({ total: 'x' })).toBe(0);
    expect(getTokenUsageTotal({ total: Number.NaN })).toBe(0);
  });

  it('returns 0 for null / undefined / non-object', () => {
    expect(getTokenUsageTotal(null)).toBe(0);
    expect(getTokenUsageTotal(undefined)).toBe(0);
    expect(getTokenUsageTotal('12')).toBe(0);
    expect(getTokenUsageTotal([])).toBe(0);
  });

  it('ignores bucket sub-fields (noCache/cacheRead/...) — only .total counts', () => {
    // The bucket shape has more fields, but getTokenUsageTotal only
    // considers .total. Pin this so a future "sum of parts" refactor
    // does not silently change the contract.
    expect(
      getTokenUsageTotal({ noCache: 50, cacheRead: 50, total: 80 }),
    ).toBe(80);
  });
});

describe('aggregateTokenUsage', () => {
  it('returns zeros for an empty array', () => {
    expect(aggregateTokenUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('returns zeros when no step has a usage field', () => {
    expect(aggregateTokenUsage([{}, { other: 1 }])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('sums numeric buckets across steps', () => {
    const r = aggregateTokenUsage([
      { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
    ]);
    expect(r).toEqual({ inputTokens: 30, outputTokens: 13, totalTokens: 43 });
  });

  it('sums object buckets via getTokenUsageTotal (.total)', () => {
    const r = aggregateTokenUsage([
      {
        usage: {
          inputTokens: { total: 100, cacheRead: 40 },
          outputTokens: { total: 50 },
          totalTokens: 150,
        },
      },
      {
        usage: {
          inputTokens: 25,
          outputTokens: { total: 5 },
          totalTokens: 30,
        },
      },
    ]);
    expect(r).toEqual({ inputTokens: 125, outputTokens: 55, totalTokens: 180 });
  });

  it('treats missing buckets as 0 (not undefined)', () => {
    const r = aggregateTokenUsage([
      { usage: { totalTokens: 10 } },
      { usage: { inputTokens: 3, outputTokens: 4 } },
    ]);
    // First step contributes (0, 0, 10); second contributes (3, 4, 0).
    expect(r).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 10 });
  });

  it('skips malformed buckets (NaN/Infinity → 0) without throwing', () => {
    const r = aggregateTokenUsage([
      { usage: { inputTokens: Number.NaN, outputTokens: Number.NaN } },
      { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } },
    ]);
    expect(r).toEqual({ inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  });

  it('does not mutate the input array or its step records', () => {
    const steps = [
      { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ];
    const snapshot = JSON.stringify(steps);
    aggregateTokenUsage(steps);
    expect(JSON.stringify(steps)).toBe(snapshot);
  });

  it('accepts readonly arrays', () => {
    // aggregateTokenUsage's parameter is ReadonlyArray<...>. This is a
    // compile-time guarantee; this test documents that a `as const`
    // tuple works at runtime too.
    const steps = [
      { usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } },
    ] as const;
    expect(aggregateTokenUsage(steps).totalTokens).toBe(8);
  });
});
