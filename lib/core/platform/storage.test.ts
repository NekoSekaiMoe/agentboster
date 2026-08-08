import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage, defaultStorage } from './storage';

describe('defaultStorage', () => {
  it('returns null for a missing key and does not throw', () => {
    const value = defaultStorage.getItem('__test_key_that_does_not_exist__');
    expect(value).toBeNull();
  });

  it('returns null when window is undefined (SSR)', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(defaultStorage.getItem('any')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('createMemoryStorage', () => {
  it('stores and retrieves values', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    expect(storage.getItem('a')).toBe('1');
  });

  it('returns null for missing keys', () => {
    const storage = createMemoryStorage();
    expect(storage.getItem('missing')).toBeNull();
  });

  it('removes values', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    storage.removeItem('a');
    expect(storage.getItem('a')).toBeNull();
  });

  it('overwrites on subsequent setItem', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('a', '2');
    expect(storage.getItem('a')).toBe('2');
  });

  it('exposes __store for direct test inspection', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    expect(storage.__store.get('a')).toBe('1');
  });
});
