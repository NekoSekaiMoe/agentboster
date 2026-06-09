import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { BotShell } from '@/components/bot-shell';
import { ConfigProvider } from '@/components/config/config-provider';
import { ReactQueryProvider } from '@/components/react-query-provider';
import { requireAdminAccess } from '@/lib/auth/access';

export default async function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  try {
    await requireAdminAccess(cookieStore);
  } catch {
    notFound();
  }
  const defaultOpen = cookieStore.get('sidebar:state')?.value !== 'false';

  return (
    <BotShell defaultOpen={defaultOpen}>
      <ReactQueryProvider>
        <ConfigProvider>{children}</ConfigProvider>
      </ReactQueryProvider>
    </BotShell>
  );
}
