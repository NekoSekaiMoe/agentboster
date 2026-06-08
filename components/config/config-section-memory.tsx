'use client';

import { useEffect } from 'react';

import {
  CONFIG_LAST_SECTION_COOKIE,
  type ConfigSectionKey,
} from '@/components/config/config-sections';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function ConfigSectionMemory({
  section,
}: {
  section: ConfigSectionKey;
}) {
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: server redirect needs this value before client storage is available.
    document.cookie = `${CONFIG_LAST_SECTION_COOKIE}=${encodeURIComponent(
      section,
    )}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  }, [section]);

  return null;
}
