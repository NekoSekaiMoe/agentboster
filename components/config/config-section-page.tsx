'use client';

import { ConfigSectionForm } from '@/components/config/config-forms';
import type { ConfigSectionKey } from '@/components/config/config-sections';
import { ConfigShell } from '@/components/config/config-shell';

export function ConfigSectionPage({ section }: { section: ConfigSectionKey }) {
  return (
    <ConfigShell section={section}>
      <ConfigSectionForm section={section} />
    </ConfigShell>
  );
}
