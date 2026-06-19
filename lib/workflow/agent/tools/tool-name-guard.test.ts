import { describe, expect, it } from 'vitest';
import {
  isValidToolName,
  sanitizeToolName,
  suggestClosestName,
} from './tool-name-guard';

describe('isValidToolName', () => {
  it('accepts simple ascii names', () => {
    expect(isValidToolName('readFile')).toBe(true);
    expect(isValidToolName('web_search')).toBe(true);
  });

  it('accepts names starting with an underscore', () => {
    expect(isValidToolName('_internal')).toBe(true);
    expect(isValidToolName('_')).toBe(true);
  });

  it('accepts the full allowed character set after the first char', () => {
    expect(isValidToolName('a.b:c-d_e')).toBe(true);
    expect(isValidToolName('foo:bar.baz-qux_zot')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidToolName('')).toBe(false);
  });

  it('rejects names that do not start with a letter or underscore', () => {
    // Gemini's first-char rule is the strictest gate.
    expect(isValidToolName('1read')).toBe(false);
    expect(isValidToolName('-dash')).toBe(false);
    expect(isValidToolName('.dot')).toBe(false);
    expect(isValidToolName(':colon')).toBe(false);
    expect(isValidToolName('0')).toBe(false);
  });

  it('rejects names with characters outside the allowed set', () => {
    expect(isValidToolName('read file')).toBe(false); // space
    expect(isValidToolName('read/file')).toBe(false); // slash
    expect(isValidToolName('read@file')).toBe(false); // at-sign
    expect(isValidToolName('阻止')).toBe(false); // non-ASCII (CJK)
    expect(isValidToolName('café')).toBe(false); // non-ASCII (Latin Extended)
  });

  it('rejects names longer than 128 characters', () => {
    const long = 'a'.repeat(128);
    const tooLong = 'a'.repeat(129);
    expect(isValidToolName(long)).toBe(true);
    expect(isValidToolName(tooLong)).toBe(false);
  });
});

describe('sanitizeToolName', () => {
  const known = new Set(['writeMemory', 'readMemory', 'listSkills']);

  it('returns null for undefined / null / empty / whitespace input', () => {
    expect(sanitizeToolName(undefined, known)).toBeNull();
    expect(sanitizeToolName(null, known)).toBeNull();
    expect(sanitizeToolName('', known)).toBeNull();
    expect(sanitizeToolName('   ', known)).toBeNull();
  });

  it('exact-matches known names', () => {
    expect(sanitizeToolName('writeMemory', known)).toEqual({
      name: 'writeMemory',
      reason: 'exact',
    });
  });

  it('resolves snake_case / kebab-case aliases to their canonical name', () => {
    expect(sanitizeToolName('write_memory', known)).toEqual({
      name: 'writeMemory',
      reason: 'alias',
    });
    expect(sanitizeToolName('WRITE-MEMORY', known)).toEqual({
      name: 'writeMemory',
      reason: 'alias',
    });
  });

  it('falls back to a unique case-insensitive match', () => {
    expect(sanitizeToolName('WRITEMEMORY', known)).toEqual({
      name: 'writeMemory',
      reason: 'case-insensitive',
    });
  });

  it('returns null for truly unknown names', () => {
    expect(sanitizeToolName('doesNotExist', known)).toBeNull();
    expect(sanitizeToolName('totally_unknown_tool', known)).toBeNull();
  });
});

describe('suggestClosestName', () => {
  const known = new Set(['writeMemory', 'readMemory', 'listSkills']);

  it('returns null for empty / whitespace input', () => {
    expect(suggestClosestName('', known)).toBeNull();
    expect(suggestClosestName('   ', known)).toBeNull();
    expect(suggestClosestName(undefined, known)).toBeNull();
  });

  it('suggests a near miss within edit distance 2', () => {
    // Single-character typo: writeMemory -> writeMemorz (distance 1)
    expect(suggestClosestName('writeMemorz', known)).toBe('writeMemory');
    // Single transposition: writeMemory -> wrtieMemory (distance 2)
    expect(suggestClosestName('wrtieMemory', known)).toBe('writeMemory');
  });

  it('returns null when nothing is close enough', () => {
    expect(suggestClosestName('completelyUnrelatedName', known)).toBeNull();
  });

  it('skips trap alias keys when suggesting', () => {
    // `write_memory` is a key in TOOL_NAME_ALIASES. Even if it would be the
    // closest match by edit distance, suggestClosestName must not surface
    // it as a suggestion — it is not a real tool.
    const knownWithAlias = new Set([
      'writeMemory',
      'readMemory',
      'write_memory',
    ]);
    // Asking for a name closer to the alias than the real tool — suggestion
    // must still point to a real tool, never to a trap alias key.
    const suggestion = suggestClosestName('write_memor', knownWithAlias);
    expect(suggestion).not.toBe('write_memory');
  });
});
