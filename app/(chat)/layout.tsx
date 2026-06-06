import { cookies } from 'next/headers';

import { AdaptiveChatLayout } from '@/components/adaptive-chat-layout';

export const experimental_ppr = true;

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar:state')?.value !== 'false';

  return (
    <AdaptiveChatLayout defaultOpen={defaultOpen}>
      {children}
    </AdaptiveChatLayout>
  );
}
