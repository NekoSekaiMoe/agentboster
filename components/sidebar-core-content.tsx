'use client';

import {
  BookOpen,
  Brain,
  Clock3,
  FolderArchive,
  Globe,
  Loader2,
  Lock,
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
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { logoutAction } from '@/app/(auth)/actions';
import { useI18n } from '@/components/i18n-provider';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  deleteSessionAction,
  isAgentdEnabled,
  toggleSessionPinAction,
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
  SESSION_LIST_KEY,
  clearSessionListCache,
  invalidateSessionListQuery,
  useSessionList,
  type SessionListItem,
} from '@/hooks/use-session-list';
import { useQueryClient } from '@tanstack/react-query';
import packageJson from '@/package.json';
import { Logo } from './logo';

const navItems = [
  { label: 'Chat', icon: MessageSquare, href: '/' },
  { label: 'Files', icon: FolderArchive, href: '/files' },
  { label: 'Memory', icon: Brain, href: '/memory' },
  { label: 'Schedule', icon: Clock3, href: '/schedule' },
  { label: 'Skills', icon: Puzzle, href: '/skills' },
  { label: 'Config', icon: Settings, href: '/config' },
];

type ThemeMode = 'light' | 'dark' | 'system';

const docsUrl = 'https://github.com/niapya/agentboster';
const siteUrl = 'https://github.com/niapya/agentboster';

type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'aborted';

interface SessionItem extends SessionListItem {}

interface SidebarCoreContentProps {
  onClose: () => void;
}

export function SidebarCoreContent({ onClose }: SidebarCoreContentProps) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { theme = 'system', setTheme } = useTheme();
  const isChatPage = pathname === '/' || pathname.startsWith('/chat');

  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<SessionItem | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [agentdEnabled, setAgentdEnabled] = useState(false);

  const qc = useQueryClient();
  const { data: sessions = [], isLoading: loadingSessions } =
    useSessionList(30);

  useEffect(() => {
    isAgentdEnabled().then(setAgentdEnabled);
  }, []);

  // isChatPage-gated mount effect: when navigating off chat, clear the
  // cache for this key so a return re-fetches cleanly. (Replaces the
  // old setSessions([])+setLoadingSessions(false) branch; loadSessions
  // callback removed — useSessionList drives fetches now.)
  useEffect(() => {
    if (!isChatPage) {
      qc.setQueryData(SESSION_LIST_KEY, []);
    }
  }, [isChatPage, qc]);

  const pollStatuses = useCallback(async () => {
    if (!isChatPage || !agentdEnabled) return;
    try {
      const response = await fetch('/api/agentd/v1/sessions/status');
      if (!response.ok) return;
      const data = (await response.json()) as {
        data: Array<{ session_id: string; status: SessionStatus }>;
      };
      const statusMap = new Map(data.data.map((s) => [s.session_id, s.status]));
      qc.setQueryData<SessionItem[]>(SESSION_LIST_KEY, (current) => {
        const list = current ?? [];
        return list.map((s) => ({
          ...s,
          status: statusMap.get(s.id) ?? s.status,
        }));
      });
    } catch {
      // silent fail
    }
  }, [isChatPage, agentdEnabled, qc]);

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

  // (bus 监听已拆除——invalidation 走 invalidateSessionListQuery;upsert 走 upsertSessionListItemInCache。)

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
        qc.setQueryData<SessionItem[]>(SESSION_LIST_KEY, (current) => {
          const list = current ?? [];
          return list.filter((item) => item.id !== sessionItem.id);
        });
        invalidateSessionListQuery();
        if (pathname === `/chat/${sessionItem.id}`) {
          onClose();
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
    [pathname, router, onClose, qc],
  );

  const handleTogglePin = useCallback(
    async (sessionItem: SessionItem) => {
      const newPinned = !sessionItem.pinned;
      qc.setQueryData<SessionItem[]>(SESSION_LIST_KEY, (current) => {
        const list = current ?? [];
        return list.map((s) =>
          s.id === sessionItem.id ? { ...s, pinned: newPinned } : s,
        );
      });
      try {
        await toggleSessionPinAction({ id: sessionItem.id });
      } catch {
        qc.setQueryData<SessionItem[]>(SESSION_LIST_KEY, (current) => {
          const list = current ?? [];
          return list.map((s) =>
            s.id === sessionItem.id ? { ...s, pinned: sessionItem.pinned } : s,
          );
        });
        toast.error(t('toast.session.pinFailed'));
      }
    },
    [t, qc],
  );

  const handleAbortSession = useCallback(
    async (sessionItem: SessionItem) => {
      try {
        const response = await fetch(
          `/api/agentd/v1/sessions/${sessionItem.id}/abort`,
          {
            method: 'POST',
          },
        );
        if (!response.ok) {
          throw new Error('Abort request failed');
        }
        qc.setQueryData<SessionItem[]>(SESSION_LIST_KEY, (current) => {
          const list = current ?? [];
          return list.map((s) =>
            s.id === sessionItem.id ? { ...s, status: 'aborted' as const } : s,
          );
        });
        toast.success(t('toast.session.aborted'));
      } catch {
        toast.error(t('toast.session.abortFailed'));
      }
    },
    [qc],
  );

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await logoutAction();
      clearSessionListCache();
      onClose();
      router.push('/login');
      router.refresh();
    } catch {
      toast.error(t('toast.auth.signOutFailed'));
    } finally {
      setLoggingOut(false);
    }
  }, [router, onClose, t]);

  const StatusDot = ({ status }: { status?: string }) => {
    if (!status || status === 'idle') return null;
    if (status === 'running')
      return (
        <Loader2 className="size-3 shrink-0 animate-spin text-amber-500" />
      );
    if (status === 'waiting_user')
      return (
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
      );
    if (status === 'completed')
      return <span className="size-2 shrink-0 rounded-full bg-green-500" />;
    if (status === 'aborted')
      return (
        <span className="size-2 shrink-0 rounded-full bg-muted-foreground" />
      );
    return null;
  };

  const renderSessionItem = (sessionItem: SessionItem) => (
    <div key={sessionItem.id} className="group relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
            aria-label="Session actions"
            disabled={deletingSessionId === sessionItem.id}
          >
            {deletingSessionId === sessionItem.id ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </button>
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
      {sessionItem.manageOnly ? (
        // Manage-only row (another member's private session in a
        // workspace the actor manages): curate via the dropdown, but the
        // conversation itself is creator-only — no chat link.
        <div
          title={sessionItem.title ?? 'Untitled'}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground"
        >
          <Lock className="size-4 shrink-0" />
          <span className="flex-1 truncate">
            {sessionItem.title ?? 'Untitled'}
          </span>
          {sessionItem.pinned && <span className="text-xs">📌</span>}
        </div>
      ) : (
        <Link
          href={`/chat/${sessionItem.id}`}
          onClick={onClose}
          title={sessionItem.title ?? 'Untitled'}
          className={`flex items-center gap-2 rounded-md px-3 py-2 transition-colors ${
            pathname === `/chat/${sessionItem.id}`
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-muted'
          }`}
        >
          <StatusDot status={sessionItem.status} />
          <MessageSquare className="size-4 shrink-0" />
          <span className="flex-1 truncate">
            {sessionItem.title ?? 'Untitled'}
          </span>
          {sessionItem.visibility === 'shared' && (
            <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {sessionItem.pinned && <span className="text-xs">📌</span>}
        </Link>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-row items-center justify-between border-b p-4">
        <Link
          href="/"
          onClick={onClose}
          className="flex flex-row items-center gap-2"
        >
          <Logo width={24} height={24} />
          <span className="font-semibold text-lg">AgentBoster</span>
        </Link>
        <div className="flex items-center gap-1">
          <SidebarTrigger
            className="size-8 shrink-0 rounded-lg md:hidden"
            aria-label={t('common.openNavigation')}
          />
        </div>
      </div>

      <div className="p-4 pb-0">
        <Button
          variant="outline"
          type="button"
          className="h-9 w-full justify-start gap-2 rounded-xl"
          onClick={() => {
            onClose();
            router.push('/');
            router.refresh();
          }}
        >
          <Plus className="size-4" />
          {t('chat.newChat')}
        </Button>
      </div>

      {/* Navigation */}
      <div className="space-y-1 p-4">
        <div className="mb-2 px-3 font-semibold text-muted-foreground text-xs">
          Navigation
        </div>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className={`flex items-center gap-3 rounded-md px-3 py-2 transition-colors ${
              item.href === '/'
                ? pathname === '/' || pathname.startsWith('/chat')
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted'
                : pathname.startsWith(item.href)
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted'
            }`}
          >
            <item.icon className="size-4" />
            <span>{item.label}</span>
          </Link>
        ))}
      </div>

      {/* Sessions */}
      {isChatPage && (
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          <div className="mb-2 px-3 font-semibold text-muted-foreground text-xs">
            Recent Sessions
          </div>
          <div className="relative mb-3">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              className="h-8 pl-7 text-xs"
            />
          </div>

          {loadingSessions ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : filteredSessions.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground text-xs">
              {searchQuery ? 'No matching sessions' : 'No sessions yet'}
            </p>
          ) : (
            <div className="space-y-1">
              {pinnedSessions.length > 0 && (
                <>
                  {pinnedSessions.map(renderSessionItem)}
                  {recentSessions.length > 0 && (
                    <div className="px-3 py-1">
                      <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                        Recent
                      </span>
                    </div>
                  )}
                </>
              )}
              {recentSessions.map(renderSessionItem)}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="space-y-2 border-t p-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-start gap-3">
              <Wrench className="size-4" />
              <span>More</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as ThemeMode)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="mx-2 size-4" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mx-2 size-4" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="mx-2 size-4" />
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
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Version {packageJson.version}
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Delete confirmation dialog */}
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
    </div>
  );
}
