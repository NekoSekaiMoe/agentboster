'use client';

import { AppSidebar } from '@/components/app-sidebar';
import { MobileDrawerBridge } from '@/components/mobile-drawer-bridge';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export function BotShell({
  children,
  defaultOpen,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <MobileDrawerBridge />
      <SidebarInset className="min-w-0 bg-background">{children}</SidebarInset>
    </SidebarProvider>
  );
}
