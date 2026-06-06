'use client';

import {
  Bell,
  BookOpen,
  Bot as BotIcon,
  Brain,
  CalendarClock,
  Database,
  FileArchive,
  Gauge,
  GitBranch,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Sun,
  Wrench,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { logoutAction } from '@/app/(auth)/actions';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import packageJson from '@/package.json';

type ThemeMode = 'light' | 'dark' | 'system';

const workspaceGroups = [
  {
    label: 'Bot',
    items: [
      {
        label: 'Dashboard',
        href: '/config/monitoring',
        icon: Gauge,
      },
      {
        label: 'Model Providers',
        href: '/config/models',
        icon: Sparkles,
      },
      {
        label: 'Agents',
        href: '/config/agents',
        icon: BotIcon,
      },
      {
        label: 'Channels',
        href: '/config/channels',
        icon: Network,
      },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        label: 'Memory',
        href: '/memory',
        icon: Brain,
      },
      {
        label: 'Skills',
        href: '/skills',
        icon: Puzzle,
      },
      {
        label: 'Files',
        href: '/files',
        icon: FileArchive,
      },
      {
        label: 'Schedule',
        href: '/schedule',
        icon: CalendarClock,
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Tasks',
        href: '/config/tasks',
        icon: SquareTerminal,
      },
      {
        label: 'Notifications',
        href: '/config/notifications',
        icon: Bell,
      },
      {
        label: 'Agent Daemon',
        href: '/config/agentd',
        icon: ShieldCheck,
      },
      {
        label: 'Audit Logs',
        href: '/config/audit-logs',
        icon: Database,
      },
    ],
  },
];

const settingsHref = '/config/appearance';
const docsUrl = 'https://github.com/niapya/agentboster';

function isItemActive(pathname: string, href: string) {
  if (href === '/') {
    return pathname === '/' || pathname.startsWith('/chat');
  }

  if (href === '/config/monitoring') {
    return pathname === '/config' || pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { setOpenMobile, state } = useSidebar();
  const { theme = 'system', setTheme } = useTheme();
  const [loggingOut, setLoggingOut] = useState(false);
  const isCollapsed = state === 'collapsed';

  const activeMode =
    pathname === '/' || pathname.startsWith('/chat') ? 'chat' : 'bot';

  const flatItems = useMemo(
    () => workspaceGroups.flatMap((group) => group.items),
    [],
  );

  const activeItem = flatItems.find((item) =>
    isItemActive(pathname, item.href),
  );

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await logoutAction();
      setOpenMobile(false);
      router.push('/login');
      router.refresh();
    } catch {
      toast.error('Failed to sign out. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  }, [router, setOpenMobile]);

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      <SidebarHeader className="border-sidebar-border border-b px-3 py-3">
        <div className="flex min-h-10 items-center gap-2">
          <Link
            href="/config/monitoring"
            className="flex min-w-0 flex-1 items-center gap-2"
            onClick={() => setOpenMobile(false)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Logo width={22} height={22} />
            </span>
            {!isCollapsed && (
              <span className="min-w-0">
                <span className="block truncate font-semibold text-[15px]">
                  AgentBoster
                </span>
                <span className="block truncate text-[11px] text-sidebar-foreground/55">
                  v{packageJson.version}
                </span>
              </span>
            )}
          </Link>

          <SidebarTrigger
            className="hidden size-8 shrink-0 rounded-lg md:inline-flex"
            aria-label="Toggle sidebar"
          />
        </div>

        {!isCollapsed && (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            <Button
              asChild
              size="sm"
              variant={activeMode === 'bot' ? 'default' : 'ghost'}
              className={cn(
                'h-8 rounded-lg text-xs',
                activeMode !== 'bot' && 'text-muted-foreground',
              )}
            >
              <Link
                href="/config/monitoring"
                onClick={() => setOpenMobile(false)}
              >
                <BotIcon className="size-3.5" />
                Bot
              </Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant={activeMode === 'chat' ? 'default' : 'ghost'}
              className={cn(
                'h-8 rounded-lg text-xs',
                activeMode !== 'chat' && 'text-muted-foreground',
              )}
            >
              <Link href="/" onClick={() => setOpenMobile(false)}>
                <MessageSquare className="size-3.5" />
                Chat
              </Link>
            </Button>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        {workspaceGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = isItemActive(pathname, item.href);

                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                      >
                        <Link
                          href={item.href}
                          onClick={() => setOpenMobile(false)}
                        >
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter className="gap-2 p-3">
        {!isCollapsed && activeItem ? (
          <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/45 px-3 py-2">
            <div className="text-[11px] text-sidebar-foreground/50 uppercase">
              Current
            </div>
            <div className="mt-0.5 truncate font-medium text-sm">
              {activeItem.label}
            </div>
          </div>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton>
              <Wrench className="size-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as ThemeMode)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="mr-2 size-4" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mr-2 size-4" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="mr-2 size-4" />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={settingsHref} onClick={() => setOpenMobile(false)}>
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <BookOpen className="size-4" />
                Documentation
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <GitBranch className="size-4" />
                GitHub
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={loggingOut}
              onSelect={() => void handleLogout()}
            >
              <LogOut className="size-4" />
              {loggingOut ? 'Signing out...' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
