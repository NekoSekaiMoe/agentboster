'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { useNavMode } from '@/hooks/use-nav-mode';
import { MobileNav } from './mobile-nav';

const HIDDEN_PATHS = ['/login'];

export function MobileNavWrapper() {
  const pathname = usePathname();
  const { navMode } = useNavMode();

  if (HIDDEN_PATHS.includes(pathname)) {
    return null;
  }

  if (navMode === 'sidebar-drawer') {
    return (
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('open-mobile-drawer'))}
        className="fixed top-3 left-3 z-30 p-2 rounded-md bg-background/80 backdrop-blur border shadow-sm hover:bg-muted transition-colors md:hidden"
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </button>
    );
  }

  return <MobileNav />;
}
