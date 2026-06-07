'use client';

import {
  Bell,
  Brain,
  Clock3,
  FolderArchive,
  History,
  MessageSquare,
  Puzzle,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';

import { useI18n } from '@/components/i18n-provider';
import type { TranslationKey } from '@/lib/i18n';

const navItems = [
  {
    labelKey: 'nav.chat',
    icon: MessageSquare,
    href: '/',
    match: (p: string) => p === '/' || p.startsWith('/chat'),
  },
  {
    labelKey: 'nav.files',
    icon: FolderArchive,
    href: '/files',
    match: (p: string) => p.startsWith('/files'),
  },
  {
    labelKey: 'nav.memory',
    icon: Brain,
    href: '/memory',
    match: (p: string) => p.startsWith('/memory'),
  },
  {
    labelKey: 'nav.schedule',
    icon: Clock3,
    href: '/schedule',
    match: (p: string) => p.startsWith('/schedule'),
  },
  {
    labelKey: 'nav.skills',
    icon: Puzzle,
    href: '/skills',
    match: (p: string) => p.startsWith('/skills'),
  },
  {
    labelKey: 'nav.tasks',
    icon: History,
    href: '/config/tasks',
    match: (p: string) => p.startsWith('/config/tasks'),
  },
  {
    labelKey: 'nav.alerts',
    icon: Bell,
    href: '/config/notifications',
    match: (p: string) => p.startsWith('/config/notifications'),
  },
  {
    labelKey: 'nav.config',
    icon: Settings,
    href: '/config',
    match: (p: string) =>
      p.startsWith('/config') &&
      !p.startsWith('/config/tasks') &&
      !p.startsWith('/config/notifications'),
  },
] as const satisfies ReadonlyArray<{
  href: string;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
  match: (pathname: string) => boolean;
}>;

export function MobileNav() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav className="fixed right-0 bottom-0 left-0 z-50 border-t bg-background/95 backdrop-blur md:hidden">
      <div className="flex items-center justify-around pb-[env(safe-area-inset-bottom)]">
        {navItems.map((item) => {
          const isActive = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-w-0 flex-col items-center gap-0.5 px-3 py-2 ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              <Icon className="size-5" />
              <span className="truncate font-medium text-[10px]">
                {t(item.labelKey)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
