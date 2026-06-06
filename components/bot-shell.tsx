'use client';

import { motion, useReducedMotion } from 'framer-motion';

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
  const reduceMotion = useReducedMotion();
  const pageTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.22, 1, 0.36, 1] };

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <MobileDrawerBridge />
      <SidebarInset className="min-w-0 bg-background">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={pageTransition}
          className="min-h-svh min-w-0 flex-1"
        >
          {children}
        </motion.div>
      </SidebarInset>
    </SidebarProvider>
  );
}
