'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  defaultLocale,
  type Locale,
  localeLabels,
  locales,
  normalizeLocale,
  type PluralTranslationKeys,
  translate,
  translatePlural,
  type TranslationKey,
  type TranslationValues,
} from '@/lib/i18n';

const STORAGE_KEY = 'agentboster.locale';

type I18nContextValue = {
  locale: Locale;
  localeLabels: Record<Locale, string>;
  locales: typeof locales;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
  tp: (
    keys: PluralTranslationKeys,
    count: number,
    values?: TranslationValues,
  ) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') {
    return defaultLocale;
  }

  try {
    const storedLocale = window.localStorage.getItem(STORAGE_KEY);
    if (storedLocale) {
      return normalizeLocale(storedLocale);
    }
  } catch {
    // Fall through to browser language detection.
  }

  const browserLanguages =
    window.navigator.languages && window.navigator.languages.length > 0
      ? window.navigator.languages
      : [window.navigator.language];

  for (const browserLanguage of browserLanguages) {
    const locale = normalizeLocale(browserLanguage);
    if (locale !== defaultLocale || browserLanguage.toLowerCase() === 'en-us') {
      return locale;
    }
  }

  return defaultLocale;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    setLocaleState(getStoredLocale());
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);

    try {
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {
      // Ignore storage failures; the in-memory locale still updates.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(locale, key, values),
    [locale],
  );
  const tp = useCallback(
    (keys: PluralTranslationKeys, count: number, values?: TranslationValues) =>
      translatePlural(locale, keys, count, values),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      localeLabels,
      locales,
      setLocale,
      t,
      tp,
    }),
    [locale, setLocale, t, tp],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }

  return context;
}
