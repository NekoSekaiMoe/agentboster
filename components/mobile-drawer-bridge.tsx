'use client';

import { X } from 'lucide-react';
import { useEffect } from 'react';

import { useSidebar } from '@/components/ui/sidebar';

// Listen for drawer-open events dispatched from MobileNavWrapper
// (which lives outside SidebarProvider in the root layout).
export function MobileDrawerBridge() {
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    const handler = () => setOpenMobile(true);
    window.addEventListener('open-mobile-drawer', handler);
    return () => window.removeEventListener('open-mobile-drawer', handler);
  }, [setOpenMobile]);

  return null;
}
