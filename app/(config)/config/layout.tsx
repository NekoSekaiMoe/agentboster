import { cookies } from 'next/headers';

import { AppSidebar } from '@/components/app-sidebar';
import { ConfigProvider } from '@/components/config/config-provider';
import { MobileDrawerBridge } from '@/components/mobile-drawer-bridge';
import { ReactQueryProvider } from '@/components/react-query-provider';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export default async function ConfigLayout({
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
      <SidebarInset>
        <ReactQueryProvider>
          <ConfigProvider>{children}</ConfigProvider>
        </ReactQueryProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
