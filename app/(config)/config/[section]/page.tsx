import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { ConfigSectionPage } from '@/components/config/config-section-page';
import { isConfigSectionKey } from '@/components/config/config-sections';
import { requireAuthAccess } from '@/lib/auth/access';

const ADMIN_ONLY_SECTIONS = new Set([
  'monitoring',
  'models',
  'agents',
  'security',
  'autonomy',
  'tools',
  'mcp',
  'agentd',
  'tasks',
  'notifications',
  'audit-logs',
  'users',
  'raw-json',
]);

export default async function ConfigSectionRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;

  if (!isConfigSectionKey(section)) {
    notFound();
  }

  if (ADMIN_ONLY_SECTIONS.has(section)) {
    const cookieStore = await cookies();
    try {
      const access = await requireAuthAccess(cookieStore);
      if (!access.isAdmin) {
        notFound();
      }
    } catch {
      notFound();
    }
  }

  return <ConfigSectionPage section={section} />;
}
