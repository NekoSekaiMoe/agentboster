import { describe, expect, it } from 'vitest';

import {
  bigramSimilarity,
  dedupeNearDuplicateContents,
  isNearDuplicate,
  wordBigrams,
} from './bigram';

describe('wordBigrams', () => {
  it('produces lowercase bigrams split on whitespace', () => {
    expect(wordBigrams('Hello world')).toEqual(new Set(['hello world']));
  });

  it('strips punctuation and collapses extra whitespace', () => {
    expect(wordBigrams('Hello,  world! Foo.')).toEqual(
      new Set(['hello world', 'world foo']),
    );
  });

  it('handles unicode letters and numbers', () => {
    expect(wordBigrams(' Café 2 cups')).toEqual(new Set(['café 2', '2 cups']));
  });

  it('returns empty set for empty or single-word content', () => {
    expect(wordBigrams('')).toEqual(new Set());
    expect(wordBigrams('solo')).toEqual(new Set());
  });

  it('caps at 200 bigrams to bound work on long content', () => {
    const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    expect(wordBigrams(long).size).toBe(200);
  });
});

describe('bigramSimilarity', () => {
  it('returns 0 when either side has no bigrams', () => {
    expect(bigramSimilarity('solo', 'another thing')).toBe(0);
    expect(bigramSimilarity('another thing', '')).toBe(0);
  });

  it('returns 1 for identical contents', () => {
    expect(bigramSimilarity('the user prefers dark mode', 'the user prefers dark mode')).toBe(1);
  });

  it('scores a rephrase high enough to count as near-duplicate', () => {
    // Same meaning, slightly different wording — overlap on core bigrams.
    const a = 'the user prefers dark mode for late night coding';
    const b = 'the user prefers dark mode when coding at night';
    expect(bigramSimilarity(a, b)).toBeGreaterThan(0.4);
  });

  it('scores unrelated contents low', () => {
    expect(
      bigramSimilarity('the user prefers dark mode', 'postgres uses mvcc for concurrency'),
    ).toBeLessThan(0.2);
  });
});

describe('isNearDuplicate', () => {
  it('flags rephrasings as duplicates at the default threshold', () => {
    expect(
      isNearDuplicate(
        'user prefers dark mode for late night coding',
        'user prefers dark mode when coding at night',
      ),
    ).toBe(true);
  });

  it('does not flag unrelated facts as duplicates', () => {
    expect(
      isNearDuplicate(
        'user prefers dark mode',
        'user works on a postgres-backed app',
      ),
    ).toBe(false);
  });
});

describe('dedupeNearDuplicateContents', () => {
  it('keeps the first of each near-duplicate cluster and rejects the rest', () => {
    const { accepted, rejected } = dedupeNearDuplicateContents({
      contents: [
        'user prefers dark mode for late night coding',
        'user prefers dark mode when coding at night', // dup of 0
        'user works on a postgres-backed app',
        'user prefers dark mode at night while coding', // dup of 0
      ],
    });
    expect(accepted).toEqual([0, 2]);
    expect(rejected.map((r) => r.index).sort()).toEqual([1, 3]);
    expect(rejected.every((r) => r.duplicateOf === 0)).toBe(true);
  });

  it('accepts everything when contents are unrelated', () => {
    const { accepted, rejected } = dedupeNearDuplicateContents({
      contents: [
        'user prefers dark mode',
        'project uses tailwind css',
        'api is built with next.js',
      ],
    });
    expect(accepted).toEqual([0, 1, 2]);
    expect(rejected).toEqual([]);
  });

  it('handles empty input', () => {
    expect(dedupeNearDuplicateContents({ contents: [] })).toEqual({
      accepted: [],
      rejected: [],
    });
  });
});
