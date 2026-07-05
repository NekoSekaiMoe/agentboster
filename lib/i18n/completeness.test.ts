import { describe, it, expect } from 'vitest';
import { translations, locales, defaultLocale } from '@/lib/i18n';

describe('i18n all-locale completeness', () => {
  const enKeys = Object.keys(translations[defaultLocale]).sort();

  it('en-US has the canonical key count (update when adding namespace)', () => {
    // Snapshot-style guard: every locale must match en-US exactly (tested below).
    // This assertion catches accidental key removals from en-US itself.
    expect(enKeys.length).toBe(682);
  });

  it.each(locales)('%s has full key set', (locale) => {
    const keys = Object.keys(translations[locale]).sort();
    expect(keys).toEqual(enKeys);
  });
});
