'use client';

import { useEffect, useState } from 'react';

import type { AppConfig } from '@/types/config';

/**
 * Client-side fetch of the running AppConfig. Used by chat components
 * that need to know feature flags (TTS, follow-ups) without going
 * through the ConfigProvider dance.
 *
 * This is a minimal hook — no mutation, no caching beyond the
 * component lifetime. Refetches when `enabled` flips true.
 */
export function useAppConfig(enabled = true): {
  config: AppConfig | null;
  loading: boolean;
} {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch('/api/config', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as AppConfig;
      })
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setConfig(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { config, loading };
}
