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
  translate,
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
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') {
    return defaultLocale;
  }

  try {
    const storedLocale = window.localStorage.getItem(STORAGE_KEY);
    return normalizeLocale(storedLocale ?? window.navigator.language);
  } catch {
    return normalizeLocale(window.navigator.language);
  }
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

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      localeLabels,
      locales,
      setLocale,
      t,
    }),
    [locale, setLocale, t],
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
