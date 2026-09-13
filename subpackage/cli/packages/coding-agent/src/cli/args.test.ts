import { describe, expect, it } from 'vitest';

import { parseArgs } from './args.ts';

describe('parseArgs -- end-of-options delimiter (pi #7269)', () => {
  it('treats everything after -- as positional messages', () => {
    const result = parseArgs(['--', '--verbose', '-p', 'hello']);
    expect(result.messages).toEqual(['--verbose', '-p', 'hello']);
    expect(result.verbose).toBeUndefined();
    expect(result.unknownFlags.size).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('keeps options parsed before --', () => {
    const result = parseArgs(['--verbose', '--', 'looks like --flag']);
    expect(result.verbose).toBe(true);
    expect(result.messages).toEqual(['looks like --flag']);
  });

  it('does not consume -- as a message', () => {
    const result = parseArgs(['a', '--', 'b']);
    expect(result.messages).toEqual(['a', 'b']);
  });

  it('supports a literal -- message after the delimiter', () => {
    const result = parseArgs(['--', '--']);
    expect(result.messages).toEqual(['--']);
  });

  it('still reports unknown dash options without a delimiter', () => {
    const result = parseArgs(['--definitely-not-a-flag']);
    expect(result.messages).toEqual([]);
    expect(
      result.diagnostics.length + result.unknownFlags.size,
    ).toBeGreaterThan(0);
  });
});
