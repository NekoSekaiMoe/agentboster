/**
 * Tests for the L1 score cache.
 *
 * The KV layer is mocked so the tests run without a live Upstash
 * connection. The point of these tests is the cache *policy*: which
 * levels get cached, how the key is built, and that KV errors do not
 * propagate.
 *
 * Run via: yarn test lib/security/l1-cache.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildL1ScoreCacheKey,
  DEFAULT_L1_CACHE_TTL_SECONDS,
  getCachedL1Score,
  resolveL1CacheTtlSeconds,
  setCachedL1Score,
} from './l1-cache';
import type { L1ScoreResult } from './l1-scorer';

// In-memory KV store backing the mocked getKV().
let kvStore = new Map<string, string>();
const kvSetSpy = vi.fn();
const kvGetSpy = vi.fn();

vi.mock('@/lib/core/kv', () => ({
  getKV: () => ({
    get: async (key: string) => {
      kvGetSpy(key);
      return kvStore.get(key) ?? null;
    },
    set: async (key: string, value: string, opts?: { ex?: number }) => {
      kvSetSpy(key, value, opts);
      kvStore.set(key, value);
      return 'OK';
    },
  }),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

const low: L1ScoreResult = { score: 0.1, level: 'low', reason: 'safe' };
const medium: L1ScoreResult = {
  score: 0.5,
  level: 'medium',
  reason: 'review',
};
const high: L1ScoreResult = {
  score: 0.85,
  level: 'high',
  reason: 'risky',
};
const critical: L1ScoreResult = {
  score: 0.95,
  level: 'critical',
  reason: 'dangerous',
};

describe('buildL1ScoreCacheKey', () => {
  it('is stable for identical inputs', () => {
    const a = buildL1ScoreCacheKey({
      command: 'git status',
      workDir: '/repo',
      contextSummary: 'ctx',
      modelId: 'm1',
    });
    const b = buildL1ScoreCacheKey({
      command: 'git status',
      workDir: '/repo',
      contextSummary: 'ctx',
      modelId: 'm1',
    });
    expect(a).toBe(b);
    expect(a.startsWith('l1:score:')).toBe(true);
  });

  it('changes when the model changes', () => {
    const a = buildL1ScoreCacheKey({
      command: 'git status',
      modelId: 'm1',
    });
    const b = buildL1ScoreCacheKey({
      command: 'git status',
      modelId: 'm2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when context summary changes', () => {
    const a = buildL1ScoreCacheKey({
      command: 'rm -rf /tmp/x',
      contextSummary: 'session-A',
      modelId: 'm',
    });
    const b = buildL1ScoreCacheKey({
      command: 'rm -rf /tmp/x',
      contextSummary: 'session-B',
      modelId: 'm',
    });
    expect(a).not.toBe(b);
  });

  it('treats undefined optional fields the same as empty', () => {
    const a = buildL1ScoreCacheKey({
      command: 'ls',
      modelId: 'm',
    });
    const b = buildL1ScoreCacheKey({
      command: 'ls',
      workDir: '',
      contextSummary: '',
      modelId: 'm',
    });
    expect(a).toBe(b);
  });
});

describe('resolveL1CacheTtlSeconds', () => {
  it('returns the default when unset', () => {
    expect(resolveL1CacheTtlSeconds(undefined)).toBe(
      DEFAULT_L1_CACHE_TTL_SECONDS,
    );
  });

  it('returns 0 (disabled) for non-positive values', () => {
    expect(resolveL1CacheTtlSeconds(0)).toBe(0);
    expect(resolveL1CacheTtlSeconds(-5)).toBe(0);
  });

  it('caps absurdly large values at 1 hour', () => {
    expect(resolveL1CacheTtlSeconds(999_999)).toBe(60 * 60);
  });

  it('passes through in-range values', () => {
    expect(resolveL1CacheTtlSeconds(120)).toBe(120);
  });
});

describe('getCachedL1Score / setCachedL1Score', () => {
  beforeEach(() => {
    kvStore = new Map();
    kvSetSpy.mockClear();
    kvGetSpy.mockClear();
  });

  it('round-trips a low verdict', async () => {
    const key = buildL1ScoreCacheKey({
      command: 'ls',
      modelId: 'm',
    });
    await setCachedL1Score(key, low, 60);
    expect(kvSetSpy).toHaveBeenCalledTimes(1);
    const got = await getCachedL1Score(key);
    expect(got).toEqual(low);
  });

  it('round-trips a medium verdict', async () => {
    const key = buildL1ScoreCacheKey({
      command: 'apt install x',
      modelId: 'm',
    });
    await setCachedL1Score(key, medium, 60);
    const got = await getCachedL1Score(key);
    expect(got).toEqual(medium);
  });

  it('never writes a high verdict to KV', async () => {
    const key = buildL1ScoreCacheKey({
      command: 'rm -rf /',
      modelId: 'm',
    });
    await setCachedL1Score(key, high, 60);
    expect(kvSetSpy).not.toHaveBeenCalled();
    expect(await getCachedL1Score(key)).toBeNull();
  });

  it('never writes a critical verdict to KV', async () => {
    const key = buildL1ScoreCacheKey({
      command: 'dd if=/dev/zero of=/dev/sda',
      modelId: 'm',
    });
    await setCachedL1Score(key, critical, 60);
    expect(kvSetSpy).not.toHaveBeenCalled();
    expect(await getCachedL1Score(key)).toBeNull();
  });

  it('is a no-op when TTL is disabled', async () => {
    const key = buildL1ScoreCacheKey({
      command: 'ls',
      modelId: 'm',
    });
    await setCachedL1Score(key, low, 0);
    expect(kvSetSpy).not.toHaveBeenCalled();
    expect(await getCachedL1Score(key)).toBeNull();
  });

  it('returns null on a miss', async () => {
    const got = await getCachedL1Score('l1:score:nonexistent');
    expect(got).toBeNull();
  });

  it('defensively rejects a stale high verdict that somehow landed in KV', async () => {
    // Simulate a pre-existing high entry (e.g. left by a future level
    // rename or manual KV poke). The reader must not trust it.
    const key = 'l1:score:stale';
    kvStore.set(key, JSON.stringify(high));
    const got = await getCachedL1Score(key);
    expect(got).toBeNull();
  });

  it('swallows KV read errors and returns null', async () => {
    const { getKV } = await import('@/lib/core/kv');
    vi.spyOn(getKV(), 'get').mockRejectedValueOnce(new Error('KV down'));
    const got = await getCachedL1Score('l1:score:whatever');
    expect(got).toBeNull();
  });

  it('swallows KV write errors', async () => {
    const { getKV } = await import('@/lib/core/kv');
    vi.spyOn(getKV(), 'set').mockRejectedValueOnce(new Error('KV down'));
    const key = buildL1ScoreCacheKey({ command: 'ls', modelId: 'm' });
    await expect(setCachedL1Score(key, low, 60)).resolves.toBeUndefined();
  });
});
