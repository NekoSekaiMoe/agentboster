'use client';

import packageJson from '@/package.json';
import {
  Bell,
  BookOpen,
  Brain,
  Clock3,
  FolderArchive,
  Globe,
  History,
  Loader2,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sun,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { logoutAction } from '@/app/(auth)/actions';
import {
  deleteSessionAction,
  isAgentdEnabled,
  listRecentSessionsAction,
} from '@/app/(chat)/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  SESSION_LIST_INVALIDATED_EVENT,
  SESSION_LIST_UPSERTED_EVENT,
  type SessionListItemEventDetail,
  invalidateSessionList,
} from '@/lib/chat/session-events';
import { Logo } from './logo';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const navItems = [
  { label: 'Chat', icon: MessageSquare, href: '/' },
  { label: 'Files', icon: FolderArchive, href: '/files' },
  { label: 'Memory', icon: Brain, href: '/memory' },
  { label: 'Schedule', icon: Clock3, href: '/schedule' },
  { label: 'Skills', icon: Puzzle, href: '/skills' },
  { label: 'Tasks', icon: History, href: '/config/tasks' },
  { label: 'Notifications', icon: Bell, href: '/config/notifications' },
  { label: 'Config', icon: Settings, href: '/config' },
];

type ThemeMode = 'light' | 'dark' | 'system';

const docsUrl = 'https://niapya.github.io/clawless';
const siteUrl = 'https://github.com/niapya/clawless';

type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'aborted';

interface SessionItem {
  id: string;
  title: string | null;
  channel: string;
  createdAt: string;
  status?: SessionStatus;
  pinned?: boolean;
}

export function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { theme = 'system', setTheme } = useTheme();
  const isChatPage = pathname === '/' || pathname.startsWith('/chat');
  const chatPagePath = isChatPage ? pathname : null;

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<SessionItem | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [agentdEnabled, setAgentdEnabled] = useState(false);

  useEffect(() => {
    isAgentdEnabled().then(setAgentdEnabled);
  }, []);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await listRecentSessionsAction(30);
      setSessions(data);
    } catch {
      // silent fail for sidebar
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  // Poll session statuses when on chat page
  const pollStatuses = useCallback(async () => {
    if (!isChatPage || !agentdEnabled) return;
    try {
      const response = await fetch('/api/agentd/v1/sessions/status');
      if (!response.ok) return;
      const data = (await response.json()) as {
        data: Array<{ session_id: string; status: SessionStatus }>;
      };
      const statusMap = new Map(data.data.map((s) => [s.session_id, s.status]));
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          status: statusMap.get(s.id) ?? s.status,
        })),
      );
    } catch {
      // silent fail
    }
  }, [isChatPage, agentdEnabled]);

  useEffect(() => {
    if (!chatPagePath) {
      setSessions([]);
      setLoadingSessions(false);
      return;
    }
    void loadSessions();
  }, [chatPagePath, loadSessions]);

  // Poll statuses periodically while on chat page and tab is visible
  useEffect(() => {
    if (!isChatPage || !agentdEnabled) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      void pollStatuses();
      interval = setInterval(pollStatuses, 15_000);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === 'visible') {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isChatPage, agentdEnabled, pollStatuses]);

  useEffect(() => {
    if (!isChatPage) return;

    const handleSessionsInvalidated = () => {
      void loadSessions();
    };
    const handleSessionUpserted = (event: Event) => {
      const detail = (event as CustomEvent<SessionListItemEventDetail>).detail;
      if (!detail) return;
      setSessions((current) => {
        const next = [detail, ...current.filter((s) => s.id !== detail.id)];
        return next.slice(0, 30);
      });
    };

    window.addEventListener(
      SESSION_LIST_INVALIDATED_EVENT,
      handleSessionsInvalidated,
    );
    window.addEventListener(SESSION_LIST_UPSERTED_EVENT, handleSessionUpserted);
    return () => {
      window.removeEventListener(
        SESSION_LIST_INVALIDATED_EVENT,
        handleSessionsInvalidated,
      );
      window.removeEventListener(
        SESSION_LIST_UPSERTED_EVENT,
        handleSessionUpserted,
      );
    };
  }, [isChatPage, loadSessions]);

  // Filtered + sorted sessions: pinned first, then by search
  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    let filtered = sessions;
    if (query) {
      filtered = sessions.filter(
        (s) =>
          (s.title ?? 'Untitled').toLowerCase().includes(query) ||
          s.id.toLowerCase().includes(query),
      );
    }
    // Pinned first, then by createdAt desc
    return [...filtered].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [sessions, searchQuery]);

  const pinnedSessions = filteredSessions.filter((s) => s.pinned);
  const recentSessions = filteredSessions.filter((s) => !s.pinned);

  const handleDeleteSession = useCallback(
    async (sessionItem: SessionItem) => {
      setDeletingSessionId(sessionItem.id);
      try {
        await deleteSessionAction(sessionItem.id);
        setSessions((current) =>
          current.filter((item) => item.id !== sessionItem.id),
        );
        invalidateSessionList();
        if (pathname === `/chat/${sessionItem.id}`) {
          setOpenMobile(false);
          router.push('/');
          router.refresh();
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Failed to delete session.',
        );
      } finally {
        setDeletingSessionId((current) =>
          current === sessionItem.id ? null : current,
        );
      }
    },
    [pathname, router, setOpenMobile],
  );

  const handleTogglePin = useCallback(async (sessionItem: SessionItem) => {
    const newPinned = !sessionItem.pinned;
    // Optimistic update
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionItem.id ? { ...s, pinned: newPinned } : s,
      ),
    );
    try {
      // Pinned feature requires schema update; best-effort only
    } catch {
      // Revert on failure
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionItem.id ? { ...s, pinned: sessionItem.pinned } : s,
        ),
      );
      toast.error('Failed to pin session');
    }
  }, []);

  const handleAbortSession = useCallback(async (sessionItem: SessionItem) => {
    try {
      await fetch(`/api/agentd/v1/sessions/${sessionItem.id}/abort`, {
        method: 'POST',
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionItem.id ? { ...s, status: 'aborted' as const } : s,
        ),
      );
      toast.success('Session aborted');
    } catch {
      toast.error('Failed to abort');
    }
  }, []);

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

  // Status indicator component
  const StatusDot = ({ status }: { status?: SessionStatus }) => {
    if (!status || status === 'idle') return null;
    if (status === 'running')
      return (
        <Loader2 className="size-3 animate-spin text-amber-500 shrink-0" />
      );
    if (status === 'waiting_user')
      return (
        <span className="size-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
      );
    if (status === 'completed')
      return <span className="size-2 rounded-full bg-green-500 shrink-0" />;
    if (status === 'aborted')
      return (
        <span className="size-2 rounded-full bg-muted-foreground shrink-0" />
      );
    return null;
  };

  // Render a single session item
  const renderSessionItem = (sessionItem: SessionItem) => (
    <SidebarMenuItem key={sessionItem.id}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            aria-label="Session actions"
            disabled={deletingSessionId === sessionItem.id}
          >
            {deletingSessionId === sessionItem.id ? (
              <Loader2 className="animate-spin size-4" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuLabel className="text-xs">
            Session Actions
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => handleTogglePin(sessionItem)}>
            {sessionItem.pinned ? '📌 Unpin' : '📌 Pin'}
          </DropdownMenuItem>
          {(sessionItem.status === 'running' ||
            sessionItem.status === 'waiting_user') && (
            <DropdownMenuItem
              onSelect={() => handleAbortSession(sessionItem)}
              className="text-amber-600"
            >
              ⏹ Abort
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={deletingSessionId === sessionItem.id}
            onSelect={(event) => {
              event.preventDefault();
              setPendingDeleteSession(sessionItem);
            }}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarMenuButton
        asChild
        isActive={pathname === `/chat/${sessionItem.id}`}
      >
        <Link
          href={`/chat/${sessionItem.id}`}
          onClick={() => setOpenMobile(false)}
          title={sessionItem.title ?? 'Untitled'}
          className="flex items-center gap-2"
        >
          <StatusDot status={sessionItem.status} />
          <MessageSquare className="size-4 shrink-0" />
          <span className="truncate flex-1">
            {sessionItem.title ?? 'Untitled'}
          </span>
          {sessionItem.pinned && <span className="text-xs">📌</span>}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <div className="flex flex-row justify-between items-center">
            <Link
              href="/"
              onClick={() => setOpenMobile(false)}
              className="flex flex-row gap-1 items-center"
            >
              <Logo width={24} height={24} />
              <span className="text-lg font-semibold hover:bg-muted rounded-md cursor-pointer">
                ClawLess
              </span>
            </Link>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  type="button"
                  className="p-2 h-fit"
                  onClick={() => {
                    setOpenMobile(false);
                    router.push('/');
                    router.refresh();
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent align="end">New Chat</TooltipContent>
            </Tooltip>
          </div>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.href === '/'
                        ? pathname === '/' || pathname.startsWith('/chat')
                        : pathname.startsWith(item.href)
                    }
                  >
                    <Link href={item.href} onClick={() => setOpenMobile(false)}>
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isChatPage ? (
          <>
            <SidebarSeparator />

            <SidebarGroup>
              <SidebarGroupLabel>Recent Sessions</SidebarGroupLabel>
              <SidebarGroupContent>
                {/* Search */}
                <div className="px-2 pb-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search sessions..."
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                </div>

                {loadingSessions ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-2 py-2">
                    {searchQuery ? 'No matching sessions' : 'No sessions yet'}
                  </p>
                ) : (
                  <SidebarMenu>
                    {/* Pinned section */}
                    {pinnedSessions.length > 0 && (
                      <>
                        {pinnedSessions.map(renderSessionItem)}
                        {recentSessions.length > 0 && (
                          <div className="px-2 py-1">
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                              Recent
                            </span>
                          </div>
                        )}
                      </>
                    )}
                    {/* Recent sessions */}
                    {recentSessions.map(renderSessionItem)}
                  </SidebarMenu>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        ) : null}
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton>
              <Wrench className="size-4" />
              <span>More</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as ThemeMode)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="size-4 mx-2" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-4 mx-2" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="size-4 mx-2" />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <BookOpen className="size-4" />
                Official Docs
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={siteUrl} target="_blank" rel="noreferrer">
                <Globe className="size-4" />
                Official Website
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
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Version {packageJson.version}
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <SidebarRail />

      <AlertDialog
        open={pendingDeleteSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteSession(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "
              {pendingDeleteSession?.title ?? 'Untitled'}" and all its messages.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteSession) {
                  void handleDeleteSession(pendingDeleteSession);
                  setPendingDeleteSession(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
