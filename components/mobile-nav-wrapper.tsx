'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';

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
        type="button"
        onClick={() =>
          window.dispatchEvent(new CustomEvent('open-mobile-drawer'))
        }
        className='fixed top-[calc(env(safe-area-inset-top)+0.75rem)] left-[calc(env(safe-area-inset-left)+0.75rem)] z-30 rounded-md border bg-background/80 p-2 shadow-sm backdrop-blur transition-colors hover:bg-muted md:hidden'
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </button>
    );
  }

  return <MobileNav />;
}
