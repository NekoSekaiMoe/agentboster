'use client';

import { usePathname } from 'next/navigation';
import { MobileNav } from './mobile-nav';

const HIDDEN_PATHS = ['/login'];

export function MobileNavWrapper() {
  const pathname = usePathname();

  if (HIDDEN_PATHS.includes(pathname)) {
    return null;
  }

  return <MobileNav />;
}
