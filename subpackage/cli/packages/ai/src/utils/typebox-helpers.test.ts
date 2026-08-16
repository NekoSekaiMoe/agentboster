import { describe, expect, it } from 'vitest';
import { StringEnum } from './typebox-helpers.ts';

// TUnsafe<T> only types the inferred value; the schema surface is accessed
// structurally in the tests.
type RawSchema = Record<string, unknown>;

describe('StringEnum', () => {
  it('includes enum values and type', () => {
    const schema = StringEnum(['a', 'b'] as const) as unknown as RawSchema;
    expect(schema.type).toBe('string');
    expect(schema.enum).toEqual(['a', 'b']);
  });

  it('omits default when undefined', () => {
    const schema = StringEnum(['a', 'b'] as const) as unknown as RawSchema;
    expect('default' in schema).toBe(false);
  });

  it('preserves a non-empty default', () => {
    const schema = StringEnum(['a', 'b'] as const, {
      default: 'b',
    }) as unknown as RawSchema;
    expect(schema.default).toBe('b');
  });

  it('preserves an empty-string default', () => {
    // An empty string is a valid enum member; truthiness-based spreading
    // would silently drop it.
    const schema = StringEnum(['', 'a'] as const, {
      default: '',
    }) as unknown as RawSchema;
    expect(schema.default).toBe('');
  });

  it('includes description when provided', () => {
    const schema = StringEnum(['a'] as const, {
      description: 'pick one',
    }) as unknown as RawSchema;
    expect(schema.description).toBe('pick one');
  });
});
