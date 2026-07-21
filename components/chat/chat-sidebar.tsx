'use client';
import {
  deleteSessionAction,
  listRecentSessionsAction,
  searchSessionsAction,
  toggleSessionPinAction,
} from '@/app/(chat)/actions';
import { useI18n } from '@/components/i18n-provider';
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
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import { generateUUID } from '@/lib/utils';
import {
  SESSION_LIST_INVALIDATED_EVENT,
  SESSION_LIST_UPSERTED_EVENT,
  type SessionListItemEventDetail,
} from '@/lib/chat/session-events';
import {
  Calendar,
  ChevronLeft,
  Globe,
  Hash,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Settings,
  Sun,
  Terminal,
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

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

function getChannelIcon(channel: string) {
  if (channel === 'web') return Globe;
  if (channel === 'scheduled') return Calendar;
  if (channel.startsWith('cli:')) return Terminal;
  switch (channel) {
    case 'telegram':
      return Send;
    case 'discord':
    case 'slack':
    case 'gchat':
    case 'teams':
    case 'qq':
      return MessagesSquare;
    case 'feishu':
      return Hash;
    default:
      return MessageSquare;
  }
}

export function ChatSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { open, isMobile, setOpenMobile } = useSidebar();
  const { theme = 'system', setTheme } = useTheme();
  const { t } = useI18n();

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<SessionItem | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchedIds, setSearchedIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);

  const currentSessionId = pathname.split('/').pop();
  const isCollapsed = !open && !isMobile;

  // 加载会话列表
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await listRecentSessionsAction(30);
      setSessions(data);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Keep the sidebar in sync with session mutations dispatched from the chat
  // container (new conversation created lazily on first message, title
  // updated, session deleted elsewhere, etc.). Without this the sidebar only
  // refreshes on mount, so a freshly-created conversation wouldn't appear
  // until the user navigated or reloaded.
  useEffect(() => {
    const handleInvalidated = () => {
      void loadSessions();
    };
    const handleUpserted = (event: Event) => {
      const detail = (event as CustomEvent<SessionListItemEventDetail>).detail;
      if (!detail) return;
      setSessions((current) => {
        const next = [
          {
            id: detail.id,
            title: detail.title,
            channel: detail.channel,
            createdAt: detail.createdAt,
          } satisfies SessionItem,
          ...current.filter((s) => s.id !== detail.id),
        ];
        return next.slice(0, 30);
      });
    };

    window.addEventListener(SESSION_LIST_INVALIDATED_EVENT, handleInvalidated);
    window.addEventListener(SESSION_LIST_UPSERTED_EVENT, handleUpserted);
    return () => {
      window.removeEventListener(
        SESSION_LIST_INVALIDATED_EVENT,
        handleInvalidated,
      );
      window.removeEventListener(SESSION_LIST_UPSERTED_EVENT, handleUpserted);
    };
  }, [loadSessions]);

  // Debounced server-side search across session titles + message content
  // (including branched versions). Falls back to client-side title/id
  // filtering for short queries — the server action only runs for queries
  // long enough to be worth a DB ILIKE.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchedIds(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      searchSessionsAction(q)
        .then((ids) => setSearchedIds(new Set(ids)))
        .catch(() => setSearchedIds(null))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // 新建会话
  function handleNewChat() {
    const newSessionId = generateUUID();
    router.push(`/chat/${newSessionId}`);
    if (isMobile) setOpenMobile(false);
  }

  // 选择会话
  function handleSelectSession(sessionId: string) {
    router.push(`/chat/${sessionId}`);
    if (isMobile) setOpenMobile(false);
  }

  // 删除会话
  async function handleDeleteSession(session: SessionItem) {
    setPendingDeleteSession(session);
  }

  async function confirmDeleteSession() {
    if (!pendingDeleteSession) return;

    setDeletingSessionId(pendingDeleteSession.id);
    try {
      await deleteSessionAction(pendingDeleteSession.id);
      await loadSessions();

      if (currentSessionId === pendingDeleteSession.id) {
        router.push('/');
      }

      toast.success(t('chat.deleteSuccess'));
    } catch (error) {
      toast.error(t('chat.deleteError'));
      console.error(error);
    } finally {
      setDeletingSessionId(null);
      setPendingDeleteSession(null);
    }
  }

  async function handleTogglePin(session: SessionItem) {
    const prevPinned = session.pinned;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === session.id ? { ...s, pinned: !prevPinned } : s,
      ),
    );
    try {
      await toggleSessionPinAction({ id: session.id });
    } catch {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id ? { ...s, pinned: prevPinned } : s,
        ),
      );
      toast.error('Failed to pin session');
    }
  }

  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return 0;
  });

  // Client-side filter for the sidebar search input. Title/id match is
  // instant; message-content matches are fetched via the server action
  // and merged in (see searchSessionsAction). When a remote search has
  // returned a result set, we filter to those ids.
  const q = searchQuery.trim().toLowerCase();
  const visibleSessions =
    q && searchedIds
      ? sortedSessions.filter((s) => searchedIds.has(s.id))
      : q
        ? sortedSessions.filter(
            (s) =>
              (s.title ?? '').toLowerCase().includes(q) ||
              s.id.toLowerCase().includes(q),
          )
        : sortedSessions;

  return (
    <>
      <Sidebar className="border-r-0">
        {/* Header */}
        <SidebarHeader className="border-sidebar-border border-b p-3">
          {isMobile && (
            <div className="mb-2 flex min-h-[36px] items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg"
                aria-label={t('common.openNavigation')}
                onClick={() => setOpenMobile(false)}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
            </div>
          )}

          <Button
            variant="secondary"
            className={`w-full justify-start rounded-xl font-medium ${
              isCollapsed ? 'justify-center px-0' : ''
            }`}
            onClick={handleNewChat}
          >
            <Plus className={`h-5 w-5 ${!isCollapsed && 'mr-2'}`} />
            {!isCollapsed && t('chat.newChat')}
          </Button>
        </SidebarHeader>

        {/* Sessions List */}
        <SidebarContent className="px-3 py-3">
          {!isCollapsed && (
            <div className="flex-1 space-y-1">
              {/* Search input */}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('chat.searchSessions') ?? 'Search sessions…'}
                  className="h-8 pr-7 pl-8 text-sm"
                />
                {(searching || searchQuery) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSearchedIds(null);
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {searching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <span className="text-xs">×</span>
                    )}
                  </button>
                )}
              </div>

              {loadingSessions ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : visibleSessions.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  {searchQuery
                    ? (t('chat.noSearchResults') ?? 'No matching sessions')
                    : t('chat.noConversations')}
                </div>
              ) : (
                visibleSessions.map((session) => {
                  const ChannelIcon = getChannelIcon(session.channel);
                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      className={`group relative flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
                        currentSessionId === session.id
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : ''
                      }`}
                      onClick={() => handleSelectSession(session.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectSession(session.id);
                        }
                      }}
                    >
                      <ChannelIcon
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-label={session.channel}
                      />
                      <span className="flex-1 truncate text-sm">
                        {session.title || t('chat.newConversation')}
                      </span>
                      {session.status === 'running' && (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      )}
                      {/* Pin button: always visible when pinned, otherwise on hover. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-6 w-6 shrink-0 ${
                          session.pinned
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTogglePin(session);
                        }}
                      >
                        {session.pinned ? (
                          <PinOff className="h-3 w-3" />
                        ) : (
                          <Pin className="h-3 w-3" />
                        )}
                      </Button>
                      {/* Delete only on hover to avoid accidents. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                        disabled={deletingSessionId === session.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSession(session);
                        }}
                      >
                        {deletingSessionId === session.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </SidebarContent>

        {/* Footer */}
        <SidebarFooter className="border-sidebar-border border-t p-3">
          <div className="relative">
            <Button
              variant="ghost"
              className={`w-full justify-start rounded-xl font-medium ${
                isCollapsed ? 'justify-center px-0' : ''
              }`}
              onClick={() => setSettingsMenuOpen(!settingsMenuOpen)}
            >
              <Settings className={`h-5 w-5 ${!isCollapsed && 'mr-2'}`} />
              {!isCollapsed && t('chat.settings')}
            </Button>

            {/* Settings Menu */}
            <AnimatePresence initial={false}>
              {settingsMenuOpen && !isCollapsed && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className="absolute right-0 bottom-full left-0 z-50 mb-2 rounded-xl border bg-popover p-2 shadow-lg"
                >
                  <div className="mb-2 px-2 font-medium text-muted-foreground text-xs">
                    {t('chat.theme')}
                  </div>
                  <div className="space-y-1">
                    <Button
                      variant={theme === 'light' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('light')}
                    >
                      <Sun className="mr-2 h-4 w-4" />
                      {t('theme.light')}
                    </Button>
                    <Button
                      variant={theme === 'dark' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('dark')}
                    >
                      <Moon className="mr-2 h-4 w-4" />
                      {t('theme.dark')}
                    </Button>
                    <Button
                      variant={theme === 'system' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('system')}
                    >
                      <Monitor className="mr-2 h-4 w-4" />
                      {t('theme.system')}
                    </Button>
                  </div>

                  <div className="my-2 border-t" />

                  <Link href="/config">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      {t('chat.configManagement')}
                    </Button>
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* 删除确认对话框 */}
      <AlertDialog
        open={!!pendingDeleteSession}
        onOpenChange={(open) => !open && setPendingDeleteSession(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat.delete.description', {
                title: pendingDeleteSession?.title || t('chat.newConversation'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('chat.delete.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteSession}>
              {t('chat.delete.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 点击外部关闭设置菜单 */}
      {settingsMenuOpen && (
        <button
          type="button"
          aria-label={t('chat.settings')}
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={() => setSettingsMenuOpen(false)}
        />
      )}
    </>
  );
}
