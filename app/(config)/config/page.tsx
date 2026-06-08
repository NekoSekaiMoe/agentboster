import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

import {
  CONFIG_LAST_SECTION_COOKIE,
  isConfigSectionKey,
} from '@/components/config/config-sections';

export default async function ConfigIndexPage() {
  const cookieStore = await cookies();
  const storedSection = cookieStore.get(CONFIG_LAST_SECTION_COOKIE)?.value;
  const section =
    storedSection && isConfigSectionKey(storedSection)
      ? storedSection
      : 'monitoring';

  redirect(`/config/${section}`);
}
