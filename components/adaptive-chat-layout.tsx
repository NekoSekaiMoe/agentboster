'use client';

import { usePathname } from 'next/navigation';

import { BotShell } from '@/components/bot-shell';

function isChatWorkspace(pathname: string) {
  return (
    pathname === '/' || pathname === '/chat' || pathname.startsWith('/chat/')
  );
}

export function AdaptiveChatLayout({
  children,
  defaultOpen,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  const pathname = usePathname();

  if (isChatWorkspace(pathname)) {
    return <>{children}</>;
  }

  return <BotShell defaultOpen={defaultOpen}>{children}</BotShell>;
}
