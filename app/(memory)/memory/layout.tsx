import { cookies } from 'next/headers';

import { BotShell } from '@/components/bot-shell';

export default async function MemoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar:state')?.value !== 'false';

  return <BotShell defaultOpen={defaultOpen}>{children}</BotShell>;
}
