import { cookies } from 'next/headers';

import { BotShell } from '@/components/bot-shell';
import { ConfigProvider } from '@/components/config/config-provider';
import { ReactQueryProvider } from '@/components/react-query-provider';

export default async function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar:state')?.value !== 'false';

  return (
    <BotShell defaultOpen={defaultOpen}>
      <ReactQueryProvider>
        <ConfigProvider>{children}</ConfigProvider>
      </ReactQueryProvider>
    </BotShell>
  );
}
