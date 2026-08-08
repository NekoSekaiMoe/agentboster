import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { BotShell } from '@/components/bot-shell';
import { ConfigProvider } from '@/components/config/config-provider';
import { requireAuthAccess } from '@/lib/auth/access';

export default async function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  try {
    await requireAuthAccess(cookieStore);
  } catch {
    notFound();
  }
  const defaultOpen = cookieStore.get('sidebar:state')?.value !== 'false';

  return (
    <ConfigProvider>
      <BotShell defaultOpen={defaultOpen}>{children}</BotShell>
    </ConfigProvider>
  );
}
