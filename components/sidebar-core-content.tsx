'use client';

import {
  BookOpen,
  Brain,
  Clock3,
  FolderArchive,
  Globe,
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
  SESSION_LIST_INVALIDATED_EVENT,
  SESSION_LIST_UPSERTED_EVENT,
  type SessionListItemEventDetail,
  invalidateSessionList,
} from '@/lib/chat/session-events';
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

interface SidebarCoreContentProps {
  onClose: () => void;
}

export function SidebarCoreContent({ onClose }: SidebarCoreContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme = 'system', setTheme } = useTheme();
  const isChatPage = pathname === '/' || pathname.startsWith('/chat');

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
    if (!isChatPage) {
      setSessions([]);
      setLoadingSessions(false);
      return;
    }
    void loadSessions();
  }, [isChatPage, loadSessions]);

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
        setSessions((current) =>
          current.filter((item) => item.id !== sessionItem.id),
        );
        invalidateSessionList();
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
    [pathname, router, onClose],
  );

  const handleTogglePin = useCallback(async (sessionItem: SessionItem) => {
    const newPinned = !sessionItem.pinned;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionItem.id ? { ...s, pinned: newPinned } : s,
      ),
    );
    try {
      // Pinned feature requires schema update; best-effort only
    } catch {
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
      onClose();
      router.push('/login');
      router.refresh();
    } catch {
      toast.error('Failed to sign out. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  }, [router, onClose]);

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

  const renderSessionItem = (sessionItem: SessionItem) => (
    <div key={sessionItem.id} className="group relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded hover:bg-muted"
            aria-label="Session actions"
            disabled={deletingSessionId === sessionItem.id}
          >
            {deletingSessionId === sessionItem.id ? (
              <Loader2 className="animate-spin size-4" />
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
      <Link
        href={`/chat/${sessionItem.id}`}
        onClick={onClose}
        title={sessionItem.title ?? 'Untitled'}
        className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
          pathname === `/chat/${sessionItem.id}`
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-muted'
        }`}
      >
        <StatusDot status={sessionItem.status} />
        <MessageSquare className="size-4 shrink-0" />
        <span className="truncate flex-1">
          {sessionItem.title ?? 'Untitled'}
        </span>
        {sessionItem.pinned && <span className="text-xs">📌</span>}
      </Link>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-row justify-between items-center p-4 border-b">
        <Link
          href="/"
          onClick={onClose}
          className="flex flex-row gap-2 items-center"
        >
          <Logo width={24} height={24} />
          <span className="text-lg font-semibold">ClawLess</span>
        </Link>
        <Button
          variant="ghost"
          type="button"
          size="icon"
          onClick={() => {
            onClose();
            router.push('/');
            router.refresh();
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* Navigation */}
      <div className="p-4 space-y-1">
        <div className="text-xs font-semibold text-muted-foreground px-3 mb-2">
          Navigation
        </div>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
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
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground px-3 mb-2">
            Recent Sessions
          </div>
          <div className="relative mb-3">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
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
            <p className="text-xs text-muted-foreground px-3 py-2">
              {searchQuery ? 'No matching sessions' : 'No sessions yet'}
            </p>
          ) : (
            <div className="space-y-1">
              {pinnedSessions.length > 0 && (
                <>
                  {pinnedSessions.map(renderSessionItem)}
                  {recentSessions.length > 0 && (
                    <div className="px-3 py-1">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
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
      <div className="p-4 border-t space-y-2">
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
