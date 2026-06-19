import { describe, expect, it } from 'vitest';
import {
  TOOL_NAME_ALIASES,
  getTrapToolKeys,
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

describe('getTrapToolKeys', () => {
  it('returns an empty array for non-openai-compatible providers', () => {
    // Gemini, Anthropic and unknown formats must not register any traps —
    // the trap mechanism targets a specific OpenAI-compat failure mode.
    expect(getTrapToolKeys('google', ['readFile'])).toEqual([]);
    expect(getTrapToolKeys('anthropic', ['readFile'])).toEqual([]);
    expect(getTrapToolKeys(undefined, ['readFile'])).toEqual([]);
  });

  it('returns alias keys for openai-compatible providers', () => {
    const known = ['writeMemory', 'readMemory'];
    const traps = getTrapToolKeys('openaicompatible', known);
    expect(traps).toContain('write_memory');
    expect(traps).toContain('read_memory');
    expect(traps).toContain('write-memory');
  });

  it('NEVER returns the empty-string key', () => {
    // Regression guard: the empty key was previously registered to catch
    // "model emitted a tool_call with no function.name", but `''` is itself
    // an invalid tool name — Gemini rejects the entire tools[] array with
    // `function_declarations[N].name: Invalid function name ... Must start
    // with a letter or an underscore`, taking down the whole workflow run.
    const traps = getTrapToolKeys('openai', []);
    const trapsCompat = getTrapToolKeys('openaicompatible', []);
    expect(traps).not.toContain('');
    expect(trapsCompat).not.toContain('');
    expect(traps.every(isValidToolName)).toBe(true);
    expect(trapsCompat.every(isValidToolName)).toBe(true);
  });

  it('skips alias keys that are already real tools (avoid shadowing)', () => {
    // `write_memory` is a registered alias -> canonical `writeMemory`. If
    // `write_memory` were itself registered as a real tool, we must NOT
    // overwrite it with a trap.
    const traps = getTrapToolKeys('openai', ['write_memory']);
    expect(traps).not.toContain('write_memory');
  });

  it('every returned key maps to an alias whose canonical tool exists in TOOL_NAME_ALIASES', () => {
    // Defense for future edits: any alias added to TOOL_NAME_ALIASES must
    // remain a valid tool name, otherwise the trap would be filtered out
    // by the last-mile guard in buildAgentTools and silently do nothing.
    const traps = getTrapToolKeys('openai', []);
    for (const key of traps) {
      expect(TOOL_NAME_ALIASES[key]).toBeDefined();
      expect(isValidToolName(key)).toBe(true);
    }
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
