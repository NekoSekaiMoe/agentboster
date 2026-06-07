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

const navItems = [
  {
    label: 'Chat',
    icon: MessageSquare,
    href: '/',
    match: (p: string) => p === '/' || p.startsWith('/chat'),
  },
  {
    label: 'Files',
    icon: FolderArchive,
    href: '/files',
    match: (p: string) => p.startsWith('/files'),
  },
  {
    label: 'Memory',
    icon: Brain,
    href: '/memory',
    match: (p: string) => p.startsWith('/memory'),
  },
  {
    label: 'Schedule',
    icon: Clock3,
    href: '/schedule',
    match: (p: string) => p.startsWith('/schedule'),
  },
  {
    label: 'Skills',
    icon: Puzzle,
    href: '/skills',
    match: (p: string) => p.startsWith('/skills'),
  },
  {
    label: 'Tasks',
    icon: History,
    href: '/config/tasks',
    match: (p: string) => p.startsWith('/config/tasks'),
  },
  {
    label: 'Alerts',
    icon: Bell,
    href: '/config/notifications',
    match: (p: string) => p.startsWith('/config/notifications'),
  },
  {
    label: 'Config',
    icon: Settings,
    href: '/config',
    match: (p: string) =>
      p.startsWith('/config') &&
      !p.startsWith('/config/tasks') &&
      !p.startsWith('/config/notifications'),
  },
];

export function MobileNav() {
  const pathname = usePathname();

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
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
