'use client';

import {
  Brain,
  Clock3,
  FolderArchive,
  MessageSquare,
  Puzzle,
  Settings,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { label: 'Chat', icon: MessageSquare, href: '/', match: (p: string) => p === '/' || p.startsWith('/chat') },
  { label: 'Files', icon: FolderArchive, href: '/files', match: (p: string) => p.startsWith('/files') },
  { label: 'Memory', icon: Brain, href: '/memory', match: (p: string) => p.startsWith('/memory') },
  { label: 'Schedule', icon: Clock3, href: '/schedule', match: (p: string) => p.startsWith('/schedule') },
  { label: 'Skills', icon: Puzzle, href: '/skills', match: (p: string) => p.startsWith('/skills') },
  { label: 'Config', icon: Settings, href: '/config', match: (p: string) => p.startsWith('/config') },
];

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function MobileDrawer({ open, onClose }: MobileDrawerProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 md:hidden ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <nav
        className={`fixed top-0 bottom-0 left-0 z-50 w-full max-w-[280px] bg-background border-r shadow-lg transition-transform duration-200 ease-out md:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <span className="text-lg font-semibold">Menu</span>
            <button
              onClick={onClose}
              className="p-2 rounded-md hover:bg-muted transition-colors"
              aria-label="Close menu"
            >
              <X className="size-5" />
            </button>
          </div>

          {/* Navigation items */}
          <div className="flex-1 overflow-y-auto py-2">
            {navItems.map((item) => {
              const isActive = item.match(pathname);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={`flex items-center gap-3 px-4 py-3 mx-2 rounded-md transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <Icon className="size-5" />
                  <span className="text-sm">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
