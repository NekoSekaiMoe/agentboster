export const locales = [
  'en-US',
  'en-GB',
  'zh-CN',
  'zh-TW',
  'zh-HK',
  'ja',
  'ko',
] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en-US';

export const localeLabels: Record<Locale, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣）',
  'zh-HK': '繁體中文（香港）',
  ja: '日本語',
  ko: '한국어',
};

// Locale message tables live in ./locales/*.ts so each translator can
// edit one file without wading through 2000 lines of other languages.
// en-US is the source of truth for the key set; every other locale
// must `satisfies Record<keyof typeof enUS, string>`.
import { enUS } from './locales/en-US';
import { enGB } from './locales/en-GB';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';
import { zhHK } from './locales/zh-HK';
import { ja } from './locales/ja';
import { ko } from './locales/ko';

export const translations = {
  'en-US': enUS,
  'en-GB': enGB,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  ja,
  ko,
} as const;

export type TranslationKey = keyof typeof enUS;

export type TranslationValues = Record<string, number | string>;

export interface PluralTranslationKeys {
  one: TranslationKey;
  other: TranslationKey;
}

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) {
    return defaultLocale;
  }

  const normalized = value.toLowerCase().replaceAll('_', '-');

  if (normalized === 'en-gb' || normalized.startsWith('en-gb-')) {
    return 'en-GB';
  }

  if (
    normalized === 'en' ||
    normalized === 'en-us' ||
    normalized.startsWith('en-us-')
  ) {
    return 'en-US';
  }

  if (
    normalized === 'zh-hk' ||
    normalized.startsWith('zh-hk-') ||
    normalized.includes('-hk')
  ) {
    return 'zh-HK';
  }

  if (
    normalized === 'zh-tw' ||
    normalized.startsWith('zh-tw-') ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-hant-') ||
    normalized.includes('-tw')
  ) {
    return 'zh-TW';
  }

  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized.startsWith('zh-cn-') ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-hans-') ||
    normalized.includes('-cn')
  ) {
    return 'zh-CN';
  }

  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }

  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }

  return defaultLocale;
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values?: TranslationValues,
): string {
  const template =
    translations[locale][key] ?? translations[defaultLocale][key] ?? key;

  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match: string, token: string) => {
    const value = values[token];
    return value === undefined ? match : String(value);
  });
}

export function translatePlural(
  locale: Locale,
  keys: PluralTranslationKeys,
  count: number,
  values?: TranslationValues,
): string {
  const category = new Intl.PluralRules(locale).select(count);
  const key = category === 'one' ? keys.one : keys.other;
  return translate(locale, key, { ...values, count });
}
