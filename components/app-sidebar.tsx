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
  Languages,
  LockKeyhole,
  LogOut,
  MessageSquare,
  MessageSquareText,
  Monitor,
  Moon,
  Network,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Sun,
  Users,
  Wrench,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { toast } from 'sonner';

import { logoutAction } from '@/app/(auth)/actions';
import { useI18n } from '@/components/i18n-provider';
import { useConfigContext } from '@/components/config/config-provider';
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
import type { TranslationKey } from '@/lib/i18n';
import packageJson from '@/package.json';

type ThemeMode = 'light' | 'dark' | 'system';

type WorkspaceItem = {
  href: string;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
};

type WorkspaceGroup = {
  items: readonly WorkspaceItem[];
  labelKey: TranslationKey;
};

const workspaceGroups: readonly WorkspaceGroup[] = [
  {
    labelKey: 'nav.bot',
    items: [
      {
        labelKey: 'nav.dashboard',
        href: '/config/monitoring',
        icon: Gauge,
      },
      {
        labelKey: 'nav.modelProviders',
        href: '/config/models',
        icon: Sparkles,
      },
      {
        labelKey: 'nav.agents',
        href: '/config/agents',
        icon: BotIcon,
      },
      {
        labelKey: 'nav.chat',
        href: '/config/chat',
        icon: MessageSquareText,
      },
      {
        labelKey: 'common.language',
        href: '/config/language',
        icon: Languages,
      },
      {
        labelKey: 'nav.channels',
        href: '/config/channels',
        icon: Network,
      },
      {
        labelKey: 'nav.security',
        href: '/config/security',
        icon: LockKeyhole,
      },
    ],
  },
  {
    labelKey: 'nav.workspace',
    items: [
      {
        labelKey: 'nav.memory',
        href: '/memory',
        icon: Brain,
      },
      {
        labelKey: 'config.sections.knowledge.title',
        href: '/config/knowledge',
        icon: BookOpen,
      },
      {
        labelKey: 'nav.skills',
        href: '/skills',
        icon: Puzzle,
      },
      {
        labelKey: 'nav.files',
        href: '/files',
        icon: FileArchive,
      },
      {
        labelKey: 'nav.schedule',
        href: '/schedule',
        icon: CalendarClock,
      },
    ],
  },
  {
    labelKey: 'nav.operations',
    items: [
      {
        labelKey: 'nav.tasks',
        href: '/config/tasks',
        icon: SquareTerminal,
      },
      {
        labelKey: 'nav.notifications',
        href: '/config/notifications',
        icon: Bell,
      },
      {
        labelKey: 'nav.agentDaemon',
        href: '/config/agentd',
        icon: ShieldCheck,
      },
      {
        labelKey: 'nav.auditLogs',
        href: '/config/audit-logs',
        icon: Database,
      },
      {
        labelKey: 'nav.users',
        href: '/config/users',
        icon: Users,
      },
      {
        labelKey: 'nav.rawJson',
        href: '/config/raw-json',
        icon: GitBranch,
      },
    ],
  },
];

const settingsHref = '/config';
const docsUrl = 'https://github.com/niapya/agentboster';

const ADMIN_ONLY_CONFIG_HREFS = new Set([
  '/config/monitoring',
  '/config/models',
  '/config/agents',
  '/config/security',
  '/config/tasks',
  '/config/notifications',
  '/config/agentd',
  '/config/audit-logs',
  '/config/users',
  '/config/raw-json',
]);

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
  const { t } = useI18n();
  const { isAdmin } = useConfigContext();
  const [loggingOut, setLoggingOut] = useState(false);
  const isCollapsed = state === 'collapsed';

  const visibleGroups = useMemo(
    () =>
      isAdmin
        ? workspaceGroups
        : workspaceGroups.map((group) => ({
            ...group,
            items: group.items.filter(
              (item) =>
                !item.href.startsWith('/config/') ||
                !ADMIN_ONLY_CONFIG_HREFS.has(item.href),
            ),
          })),
    [isAdmin],
  );

  const flatItems = useMemo(
    () => visibleGroups.flatMap((group) => group.items),
    [visibleGroups],
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
      toast.error(t('auth.signOutError'));
    } finally {
      setLoggingOut(false);
    }
  }, [router, setOpenMobile, t]);

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      <SidebarHeader className="border-sidebar-border border-b px-3 py-3">
        <div className="flex min-h-10 items-center gap-2">
          <Link
            href="/config"
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
            aria-label={t('common.openNavigation')}
          />
        </div>

        {!isCollapsed ? (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-9 justify-start rounded-xl"
          >
            <Link href="/" onClick={() => setOpenMobile(false)}>
              <MessageSquare className="size-4" />
              {t('menu.backToChat')}
            </Link>
          </Button>
        ) : null}
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        {visibleGroups.map((group) => (
          <SidebarGroup key={group.labelKey} className="py-1">
            <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
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
                        tooltip={t(item.labelKey)}
                      >
                        <Link
                          href={item.href}
                          onClick={() => setOpenMobile(false)}
                        >
                          <Icon className="size-4" />
                          <span>{t(item.labelKey)}</span>
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
              {t('menu.current')}
            </div>
            <div className="mt-0.5 truncate font-medium text-sm">
              {t(activeItem.labelKey)}
            </div>
          </div>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton>
              <Wrench className="size-4" />
              <span>{t('menu.settings')}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuLabel>{t('menu.appearance')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as ThemeMode)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="mr-2 size-4" />
                {t('theme.light')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mr-2 size-4" />
                {t('theme.dark')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="mr-2 size-4" />
                {t('theme.system')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/" onClick={() => setOpenMobile(false)}>
                <MessageSquare className="size-4" />
                {t('menu.backToChat')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={settingsHref} onClick={() => setOpenMobile(false)}>
                <Settings className="size-4" />
                {t('menu.settings')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <BookOpen className="size-4" />
                {t('menu.documentation')}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <GitBranch className="size-4" />
                {t('menu.github')}
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={loggingOut}
              onSelect={() => void handleLogout()}
            >
              <LogOut className="size-4" />
              {loggingOut ? t('menu.signingOut') : t('menu.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
