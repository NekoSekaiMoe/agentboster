import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACT_RATIO,
  DEFAULT_COMPACTION_BUFFER,
  MIN_PRESERVE_RECENT_TOKENS,
  MAX_PRESERVE_RECENT_TOKENS,
  computeUsableContext,
  shouldCompress,
  isContextOverflow,
  evaluateCompactionNeed,
  estimateTextTokens,
  estimatePromptTokens,
  estimateMessageTokensFromUsage,
  SUMMARY_PROMPT_INITIAL,
  SUMMARY_PROMPT_UPDATE,
  SUMMARY_SYSTEM_PROMPT,
} from './compaction-core';

describe('computeUsableContext', () => {
  it('reserves the compaction buffer capped at maxOutputTokens', () => {
    expect(computeUsableContext(100_000, 50_000)).toBe(
      100_000 - Math.min(DEFAULT_COMPACTION_BUFFER, 50_000),
    );
  });

  it('caps the reserve at maxOutputTokens when output is smaller', () => {
    expect(computeUsableContext(100_000, 1_000)).toBe(99_000);
  });

  it('returns 0 for non-positive context limit', () => {
    expect(computeUsableContext(0, 1_000)).toBe(0);
    expect(computeUsableContext(-1, 1_000)).toBe(0);
  });

  it('honours a custom buffer', () => {
    expect(computeUsableContext(100_000, 50_000, 5_000)).toBe(95_000);
  });
});

describe('shouldCompress', () => {
  it('forces compression when force=true regardless of usage', () => {
    expect(shouldCompress(0, 100_000, DEFAULT_COMPACT_RATIO, true)).toBe(true);
  });

  it('returns false when context limit is missing or non-positive', () => {
    expect(shouldCompress(99_000, undefined)).toBe(false);
    expect(shouldCompress(99_000, 0)).toBe(false);
    expect(shouldCompress(99_000, -1)).toBe(false);
  });

  it('triggers at the configured ratio', () => {
    const limit = 100_000;
    expect(shouldCompress(limit * DEFAULT_COMPACT_RATIO, limit)).toBe(true);
    expect(shouldCompress(limit * DEFAULT_COMPACT_RATIO - 1, limit)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(shouldCompress(50_000, 100_000, 0.5)).toBe(true);
    expect(shouldCompress(49_999, 100_000, 0.5)).toBe(false);
  });
});

describe('isContextOverflow', () => {
  it('returns true once usage meets the usable window', () => {
    expect(
      isContextOverflow(99_000, 100_000, 1_000),
    ).toBe(true);
  });

  it('returns false below the usable window', () => {
    expect(
      isContextOverflow(98_000, 100_000, 1_000),
    ).toBe(false);
  });

  it('returns false for non-positive context limit', () => {
    expect(isContextOverflow(99_000, 0, 1_000)).toBe(false);
  });
});

describe('evaluateCompactionNeed', () => {
  const base = {
    contextLimit: 100_000,
    maxOutputTokens: 4_000,
  };

  it('returns a structured decision with all fields populated', () => {
    const d = evaluateCompactionNeed({ totalTokensUsed: 50_000, ...base });
    expect(d.totalTokens).toBe(50_000);
    expect(d.contextLimit).toBe(100_000);
    expect(d.usageRatio).toBeCloseTo(0.5, 5);
    expect(d.usableContext).toBe(
      100_000 - Math.min(DEFAULT_COMPACTION_BUFFER, 4_000),
    );
    expect(d.shouldCompress).toBe(false);
    expect(d.isOverflow).toBe(false);
  });

  it('triggers compression at the ratio threshold', () => {
    const d = evaluateCompactionNeed({
      totalTokensUsed: 100_000 * DEFAULT_COMPACT_RATIO,
      ...base,
    });
    expect(d.shouldCompress).toBe(true);
    expect(d.isOverflow).toBe(false);
  });

  it('flags overflow when usage hits the usable window', () => {
    const usable = computeUsableContext(100_000, 4_000);
    const d = evaluateCompactionNeed({
      totalTokensUsed: usable,
      ...base,
    });
    expect(d.isOverflow).toBe(true);
    expect(d.shouldCompress).toBe(true);
  });

  it('force overrides everything', () => {
    const d = evaluateCompactionNeed({
      totalTokensUsed: 0,
      ...base,
      force: true,
    });
    expect(d.shouldCompress).toBe(true);
  });

  it('handles non-positive context limit without throwing', () => {
    const d = evaluateCompactionNeed({
      totalTokensUsed: 1_000,
      contextLimit: 0,
      maxOutputTokens: 1_000,
    });
    expect(d.usageRatio).toBe(0);
    expect(d.shouldCompress).toBe(false);
  });
});

describe('estimateTextTokens', () => {
  it('returns ceil(length/4) for non-empty text', () => {
    expect(estimateTextTokens('hello')).toBe(2); // 5 chars / 4
    expect(estimateTextTokens('hell')).toBe(1); // 4 chars / 4
  });

  it('returns 0 for empty or whitespace-only text', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('   ')).toBe(0);
    expect(estimateTextTokens('\t\n')).toBe(0);
  });
});

describe('estimatePromptTokens', () => {
  it('sums tokens across messages (chars/4, unrounded)', () => {
    const tokens = estimatePromptTokens([
      { content: 'hello' }, // 5/4 = 1.25
      { content: 'world' }, // 5/4 = 1.25
    ]);
    expect(tokens).toBe(2.5);
  });

  it('handles array content with text parts', () => {
    const tokens = estimatePromptTokens([
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ]);
    expect(tokens).toBe(2.5);
  });

  it('ignores non-text parts', () => {
    const tokens = estimatePromptTokens([
      {
        content: [
          { type: 'image', url: 'x' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]);
    // image contributes 4800 chars / 4 = 1200, text 2/4=0.5
    expect(tokens).toBe(1200.5);
  });

  it('returns 0 for empty input', () => {
    expect(estimatePromptTokens([])).toBe(0);
  });
});

describe('estimateMessageTokensFromUsage', () => {
  it('prefers totalTokens when positive', () => {
    expect(
      estimateMessageTokensFromUsage({
        totalTokens: 500,
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toBe(500);
  });

  it('sums input + output when totalTokens missing', () => {
    expect(
      estimateMessageTokensFromUsage({ inputTokens: 300, outputTokens: 200 }),
    ).toBe(500);
  });

  it('returns 0 for null/unknown shapes', () => {
    expect(estimateMessageTokensFromUsage(null)).toBe(0);
    expect(estimateMessageTokensFromUsage({})).toBe(0);
    expect(estimateMessageTokensFromUsage('string')).toBe(0);
  });
});

describe('summary prompts', () => {
  it('exports non-empty initial and update prompts', () => {
    expect(SUMMARY_PROMPT_INITIAL.length).toBeGreaterThan(0);
    expect(SUMMARY_PROMPT_UPDATE.length).toBeGreaterThan(0);
    expect(SUMMARY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('initial prompt has the structured Goal/Progress/Decisions sections', () => {
    expect(SUMMARY_PROMPT_INITIAL).toMatch(/## Goal/);
    expect(SUMMARY_PROMPT_INITIAL).toMatch(/## Progress/);
    expect(SUMMARY_PROMPT_INITIAL).toMatch(/## Key Decisions/);
    expect(SUMMARY_PROMPT_INITIAL).toMatch(/## Next Steps/);
  });

  it('update prompt references <previous-summary>', () => {
    expect(SUMMARY_PROMPT_UPDATE).toMatch(/<previous-summary>/);
  });

  it('both prompts mention security-decision preferences (web contribution)', () => {
    expect(SUMMARY_PROMPT_INITIAL).toMatch(/security-decision/i);
    expect(SUMMARY_PROMPT_UPDATE).toMatch(/security-decision/i);
  });
});

describe('exported constants', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_COMPACT_RATIO).toBe(0.8);
    expect(DEFAULT_COMPACTION_BUFFER).toBe(20_000);
    expect(MIN_PRESERVE_RECENT_TOKENS).toBeLessThan(MAX_PRESERVE_RECENT_TOKENS);
    expect(MIN_PRESERVE_RECENT_TOKENS).toBeGreaterThan(0);
  });
});
