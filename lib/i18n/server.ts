import {
  type Locale,
  translate,
  type TranslationValues,
  locales,
  localeLabels,
} from './index';

export { type Locale, locales, localeLabels };

export function t(
  locale: Locale,
  key: Parameters<typeof translate>[1],
  values?: TranslationValues,
): string {
  return translate(locale, key, values);
}
