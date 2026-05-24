'use client';

import { useMemo } from 'react';

import type { ConfigSectionKey } from '@/components/config/config-sections';
import { useConfigDraft } from '@/hooks/use-config-draft';
import type { AppConfig } from '@/types/config';

export function useConfigSection<K extends keyof AppConfig>(sectionKey: K) {
  const config = useConfigDraft();

  const issues = useMemo(
    () =>
      config.validationIssues.filter(
        (issue) =>
          issue.path === sectionKey || issue.path.startsWith(`${sectionKey}.`),
      ),
    [config.validationIssues, sectionKey],
  );

  return {
    ...config,
    issues,
    value: config.draft[sectionKey] as AppConfig[K],
    updateValue: (value: AppConfig[K]) =>
      config.updateSection(sectionKey, value),
  };
}
