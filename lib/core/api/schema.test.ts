import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseWithFallback } from './schema';

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Intentionally lenient: role is string (not enum) so an unknown role
  // still parses. This is the "schema wider than TS type" policy.
  role: z.string(),
});

describe('parseWithFallback', () => {
  it('returns parsed value when data matches schema', () => {
    const data = { id: '1', name: 'alice', role: 'admin' };
    const result = parseWithFallback(data, userSchema, null, {
      endpoint: 'test',
    });
    expect(result).toEqual(data);
  });

  it('returns fallback when data does not match (never throws)', () => {
    const data = { id: '1' }; // missing name
    const result = parseWithFallback(data, userSchema, null, {
      endpoint: 'test',
    });
    expect(result).toBeNull();
  });

  it('returns fallback for malformed data', () => {
    const result = parseWithFallback('not an object', userSchema, null, {
      endpoint: 'test',
    });
    expect(result).toBeNull();
  });

  it('preserves fallback type inference', () => {
    const fallback = [{ id: '', name: '', role: '' }];
    const result = parseWithFallback(null, z.array(userSchema), fallback, {
      endpoint: 'test',
    });
    expect(result).toBe(fallback);
  });

  it('treats unknown enum value as valid when schema uses z.string()', () => {
    // A server adds a new role the client doesn't know about. With a strict
    // z.enum() this would fall back; with the lenient z.string() it parses.
    const data = { id: '1', name: 'a', role: 'super-new-role' };
    const result = parseWithFallback(data, userSchema, null, {
      endpoint: 'test',
    });
    expect(result).toEqual(data);
  });
});
