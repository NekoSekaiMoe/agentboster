import { describe, expect, it } from 'vitest';
import { sumUsageRows } from './usage';

describe('sumUsageRows', () => {
  it('returns empty sum for empty input', () => {
    expect(sumUsageRows([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdTicks: null,
    });
  });

  it('sums tokens across rows', () => {
    const rows = [
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsdTicks: 1000,
      },
      {
        inputTokens: 200,
        outputTokens: 75,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsdTicks: 2500,
      },
    ];
    expect(sumUsageRows(rows)).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      costUsdTicks: 3500,
    });
  });

  it('treats null token fields as 0', () => {
    const rows = [
      {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsdTicks: null,
      },
    ];
    expect(sumUsageRows(rows)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdTicks: null,
    });
  });

  it('preserves null costUsdTicks when no row has one', () => {
    const rows = [
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdTicks: null,
      },
    ];
    expect(sumUsageRows(rows).costUsdTicks).toBeNull();
  });

  it('sums costUsdTicks only over rows that have one', () => {
    // A rollup bucket can mix rows with authoritative cost and rows without
    // (two providers, or a provider before/after an upgrade that started
    // returning cost). Rows without one contribute 0; the sum stays exact.
    const rows = [
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdTicks: 1000,
      },
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdTicks: null,
      },
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdTicks: 500,
      },
    ];
    expect(sumUsageRows(rows).costUsdTicks).toBe(1500);
  });
});
