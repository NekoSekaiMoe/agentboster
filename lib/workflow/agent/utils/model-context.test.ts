/**
 * Tests for the model context / output-token resolvers.
 *
 * Pure table lookups with fuzzy matching + override precedence. No IO.
 * Pins the configuredLimit override, the exact-match and substring
 * (bidirectional includes) fallback, and the per-family default output
 * token buckets.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveModelContextLimit,
  resolveModelMaxOutputTokens,
} from './model-context';

describe('resolveModelContextLimit', () => {
  it('honors an explicit configuredLimit override (> 0)', () => {
    expect(resolveModelContextLimit('gpt-4o', 999_999)).toBe(999_999);
  });

  it('ignores a non-positive configuredLimit and falls through', () => {
    expect(resolveModelContextLimit('gpt-4o', 0)).toBe(128_000);
    expect(resolveModelContextLimit('gpt-4o', -1)).toBe(128_000);
  });

  it('ignores undefined configuredLimit', () => {
    expect(resolveModelContextLimit('gpt-4o', undefined)).toBe(128_000);
  });

  it('exact match is case-insensitive and trims whitespace', () => {
    expect(resolveModelContextLimit('  GPT-4O  ', undefined)).toBe(128_000);
    expect(resolveModelContextLimit('Claude-3-5-Sonnet', undefined)).toBe(
      200_000,
    );
  });

  it('returns the known value for a long list of models', () => {
    const cases: Record<string, number> = {
      'gpt-4': 8_192,
      'gpt-3.5-turbo': 16_384,
      o1: 200_000,
      'gemini-2.5-pro': 1_048_576,
      'gemini-1.5-pro': 2_097_152,
      'deepseek-v3': 65_536,
      'qwen-max': 32_768,
      'llama-4-scout': 10_485_760,
    };
    for (const [id, want] of Object.entries(cases)) {
      expect(resolveModelContextLimit(id, undefined)).toBe(want);
    }
  });

  it('falls back to fuzzy substring match (model id contains table key)', () => {
    // Provider-scoped id like "anthropic/claude-3-5-sonnet" has no exact
    // entry but should fuzzy-match "claude-3-5-sonnet".
    expect(
      resolveModelContextLimit('anthropic/claude-3-5-sonnet', undefined),
    ).toBe(200_000);
    expect(
      resolveModelContextLimit('openai/gpt-4o-2024-11-20', undefined),
    ).toBe(128_000);
  });

  it('falls back to fuzzy substring match (table key contains model id)', () => {
    // A shortened id like "gemini-1.5" matches because the table key
    // "gemini-1.5-pro" contains it.
    expect(resolveModelContextLimit('gemini-1.5', undefined)).toBe(2_097_152);
  });

  it('returns 128_000 default for a completely unknown model', () => {
    expect(resolveModelContextLimit('totally-unknown-model', undefined)).toBe(
      128_000,
    );
  });
});

describe('resolveModelMaxOutputTokens', () => {
  it('honors an explicit configuredMax override (> 0)', () => {
    expect(resolveModelMaxOutputTokens('gpt-4o', 99_999)).toBe(99_999);
  });

  it('ignores non-positive configuredMax', () => {
    expect(resolveModelMaxOutputTokens('gpt-4o', 0)).toBe(4_096);
    expect(resolveModelMaxOutputTokens('gpt-4o', -5)).toBe(4_096);
  });

  it('o1 / o3 / o4 family → 32_000', () => {
    expect(resolveModelMaxOutputTokens('o1', undefined)).toBe(32_000);
    expect(resolveModelMaxOutputTokens('o3-mini', undefined)).toBe(32_000);
    expect(resolveModelMaxOutputTokens('o4-mini', undefined)).toBe(32_000);
  });

  it('gemini-1.5 / gemini-2.5 → 8_192', () => {
    expect(resolveModelMaxOutputTokens('gemini-2.5-pro', undefined)).toBe(
      8_192,
    );
    expect(resolveModelMaxOutputTokens('gemini-1.5-flash', undefined)).toBe(
      8_192,
    );
  });

  it('claude family → 8_192', () => {
    expect(resolveModelMaxOutputTokens('claude-3-5-sonnet', undefined)).toBe(
      8_192,
    );
    expect(
      resolveModelMaxOutputTokens('anthropic/claude-sonnet-4-5', undefined),
    ).toBe(8_192);
  });

  it('deepseek family → 8_192', () => {
    expect(resolveModelMaxOutputTokens('deepseek-v3', undefined)).toBe(8_192);
  });

  it('defaults to 4_096 for an unknown family', () => {
    expect(resolveModelMaxOutputTokens('qwen-max', undefined)).toBe(4_096);
    expect(resolveModelMaxOutputTokens('llama-4-scout', undefined)).toBe(4_096);
  });

  it('the o-family check wins over later families (o3 not "claude")', () => {
    // Documents the if-else order: o-family is checked first.
    expect(resolveModelMaxOutputTokens('o3', undefined)).toBe(32_000);
  });
});
