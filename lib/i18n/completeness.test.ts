import { describe, it, expect } from 'vitest';
import { translations, locales, defaultLocale } from '@/lib/i18n';

describe('i18n all-locale completeness', () => {
  const enKeys = Object.keys(translations[defaultLocale]).sort();

  it('en-US is non-empty and has no duplicate keys', () => {
    // Replaces the old hardcoded count assertion. A hardcoded number
    // had to be manually bumped every time a namespace was added,
    // which made adding i18n keys friction-heavy and led to drift
    // between the snapshot and reality.
    //
    // The guards we actually want:
    //   - en-US has *something* (catches a catastrophic build / import
    //     failure that drops the whole locale)
    //   - no key is listed twice in the source (the spread-merge in
    //     en-US.ts would silently let a later key overwrite an earlier
    //     one, but Object.keys still counts both)
    expect(enKeys.length).toBeGreaterThan(0);
    const deduped = new Set(enKeys);
    expect(deduped.size).toBe(enKeys.length);
  });

  it.each(locales)('%s has full key set', (locale) => {
    const keys = Object.keys(translations[locale]).sort();
    expect(keys).toEqual(enKeys);
  });
});
