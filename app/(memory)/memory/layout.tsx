import { cookies } from 'next/headers';

import { AppSidebar } from '@/components/app-sidebar';
import { MobileDrawerBridge } from '@/components/mobile-drawer-bridge';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export default async function MemoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const isCollapsed = cookieStore.get('sidebar:state')?.value !== 'true';

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar />
      <MobileDrawerBridge />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
