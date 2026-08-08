/**
 * Tests for lib/extra/auth/api-keys.ts — pure API key generation/validation.
 *
 * No DB, no network. Covers the `ac_` prefix invariant, expiration
 * semantics, and the random generator format.
 */

import { describe, expect, it } from 'vitest';
import { createApiKey, isApiKeyExpired, isApiKeyValid } from './api-keys';

describe('createApiKey', () => {
  it('produces a key with the ac_ prefix', () => {
    const key = createApiKey('name', ['scope']);
    expect(key.key.startsWith('ac_')).toBe(true);
  });

  it('generates a 32-char random body (plus the 3-char prefix)', () => {
    const key = createApiKey('name', ['scope']);
    expect(key.key).toHaveLength(32 + 3);
  });

  it('uses only alphanumeric characters in the random body', () => {
    const key = createApiKey('name', ['scope']);
    expect(key.key.slice(3)).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('produces distinct keys across calls', () => {
    const a = createApiKey('a', []);
    const b = createApiKey('b', []);
    expect(a.key).not.toBe(b.key);
  });

  it('preserves name/scopes/expiresAt verbatim', () => {
    const key = createApiKey('my-key', ['read', 'write'], 123456);
    expect(key.name).toBe('my-key');
    expect(key.scopes).toEqual(['read', 'write']);
    expect(key.expiresAt).toBe(123456);
  });

  it('leaves expiresAt undefined when not provided', () => {
    const key = createApiKey('n', []);
    expect(key.expiresAt).toBeUndefined();
  });
});

describe('isApiKeyExpired', () => {
  it('returns false when expiresAt is absent (never expires)', () => {
    expect(isApiKeyExpired(createApiKey('n', []))).toBe(false);
  });

  it('returns false when expiresAt is in the future', () => {
    const key = createApiKey('n', [], Math.floor(Date.now() / 1000) + 60);
    expect(isApiKeyExpired(key)).toBe(false);
  });

  it('returns true when expiresAt is in the past', () => {
    const key = createApiKey('n', [], Math.floor(Date.now() / 1000) - 60);
    expect(isApiKeyExpired(key)).toBe(true);
  });
});

describe('isApiKeyValid', () => {
  it('returns true for a prefixed, non-expired key', () => {
    const key = createApiKey('n', []);
    expect(isApiKeyValid(key)).toBe(true);
  });

  it('returns false when the prefix is missing', () => {
    const key = createApiKey('n', []);
    key.key = key.key.slice(3);
    expect(isApiKeyValid(key)).toBe(false);
  });

  it('returns false when expired', () => {
    const key = createApiKey('n', [], Math.floor(Date.now() / 1000) - 1);
    expect(isApiKeyValid(key)).toBe(false);
  });
});
