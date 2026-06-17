'use client';

import { useConfigContextStrict } from '@/components/config/config-provider';

export function useConfigDraft() {
  return useConfigContextStrict();
}
