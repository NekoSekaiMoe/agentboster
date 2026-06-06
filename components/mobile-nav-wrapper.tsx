'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';

const HIDDEN_PATHS = ['/login'];

export function MobileNavWrapper() {
  const pathname = usePathname();

  if (HIDDEN_PATHS.includes(pathname)) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new CustomEvent('open-mobile-drawer'))
      }
      className="fixed top-[calc(env(safe-area-inset-top)+0.85rem)] left-[calc(env(safe-area-inset-left)+0.85rem)] z-50 inline-flex size-10 items-center justify-center rounded-xl border border-border/70 bg-background/90 text-foreground shadow-sm backdrop-blur transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-accent hover:text-accent-foreground hover:shadow-md active:scale-95 motion-reduce:transition-colors motion-reduce:active:scale-100 md:hidden"
      aria-label="Open navigation"
    >
      <Menu className="size-5" />
    </button>
  );
}
