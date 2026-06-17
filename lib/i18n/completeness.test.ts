import { describe, it, expect } from 'vitest';
import { translations, locales, defaultLocale } from '@/lib/i18n';

describe('i18n all-locale completeness', () => {
  const enKeys = Object.keys(translations[defaultLocale]).sort();

  it('en-US has 355 keys', () => {
    expect(enKeys.length).toBe(355);
  });

  it.each(locales)('%s has full key set', (locale) => {
    const keys = Object.keys(translations[locale]).sort();
    expect(keys).toEqual(enKeys);
  });
});
