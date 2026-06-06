'use client';
import {
  deleteSessionAction,
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import { generateUUID } from '@/lib/utils';
import {
  ChevronLeft,
  Loader2,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sun,
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
}

export function ChatSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { open, setOpen, isMobile, setOpenMobile } = useSidebar();
  const { theme = 'system', setTheme } = useTheme();

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<SessionItem | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);

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

      toast.success('会话已删除');
    } catch (error) {
      toast.error('删除失败');
      console.error(error);
    } finally {
      setDeletingSessionId(null);
      setPendingDeleteSession(null);
    }
  }

  return (
    <>
      <Sidebar className="border-r-0">
        {/* Header */}
        <SidebarHeader className="border-sidebar-border border-b p-3">
          {!isMobile && (
            <div className="mb-2 flex min-h-[36px] items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-lg"
                onClick={() => setOpen(!open)}
              >
                <ChevronLeft
                  className={`h-5 w-5 transition-transform ${
                    isCollapsed ? 'rotate-180' : ''
                  }`}
                />
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
            {!isCollapsed && '新建对话'}
          </Button>
        </SidebarHeader>

        {/* Sessions List */}
        <SidebarContent className="px-3 py-3">
          {!isCollapsed && (
            <div className="flex-1 space-y-1">
              {loadingSessions ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  暂无对话
                </div>
              ) : (
                sessions.map((session) => (
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
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate text-sm">
                      {session.title || '新对话'}
                    </span>
                    {session.status === 'running' && (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    )}
                    <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
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
                  </div>
                ))
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
              {!isCollapsed && '设置'}
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
                    主题
                  </div>
                  <div className="space-y-1">
                    <Button
                      variant={theme === 'light' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('light')}
                    >
                      <Sun className="mr-2 h-4 w-4" />
                      浅色
                    </Button>
                    <Button
                      variant={theme === 'dark' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('dark')}
                    >
                      <Moon className="mr-2 h-4 w-4" />
                      深色
                    </Button>
                    <Button
                      variant={theme === 'system' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setTheme('system')}
                    >
                      <Monitor className="mr-2 h-4 w-4" />
                      系统
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
                      配置管理
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
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除会话 "{pendingDeleteSession?.title || '新对话'}" 吗？
              此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteSession}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 点击外部关闭设置菜单 */}
      {settingsMenuOpen && (
        <button
          type="button"
          aria-label="关闭设置菜单"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={() => setSettingsMenuOpen(false)}
        />
      )}
    </>
  );
}
