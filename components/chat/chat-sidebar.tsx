'use client';

import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  deleteSessionAction,
  listRecentSessionsAction
} from '@/app/(chat)/actions';
import {
  Plus,
  ChevronLeft,
  MessageSquare,
  Loader2,
  Pencil,
  Trash2,
  Settings,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter, usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { generateUUID } from '@/lib/utils';
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
import Link from 'next/link';

type SessionStatus = 'idle' | 'running' | 'waiting_user' | 'completed' | 'aborted';

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
  const { open, setOpen, isMobile } = useSidebar();
  const { theme = 'system', setTheme } = useTheme();

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionItem | null>(null);
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
    if (isMobile) setOpen(false);
  }

  // 选择会话
  function handleSelectSession(sessionId: string) {
    router.push(`/chat/${sessionId}`);
    if (isMobile) setOpen(false);
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
      <Sidebar
        className="border-r"
        style={{
          backgroundColor: 'var(--sidebar-bg)',
        }}
      >
        {/* Header */}
        <SidebarHeader className="p-3">
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
            variant="ghost"
            className={`w-full justify-start rounded-lg font-medium ${
              isCollapsed ? 'px-0 justify-center' : ''
            }`}
            onClick={handleNewChat}
          >
            <Plus className={`h-5 w-5 ${!isCollapsed && 'mr-2'}`} />
            {!isCollapsed && '新建对话'}
          </Button>
        </SidebarHeader>

        {/* Sessions List */}
        <SidebarContent className="px-3">
          {!isCollapsed && (
            <div className="flex-1 space-y-1">
              {loadingSessions ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  暂无对话
                </div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    className={`group relative flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-accent ${
                      currentSessionId === session.id
                        ? 'bg-accent/80'
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
                    <div
                      className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={deletingSessionId === session.id}
                      >
                        {deletingSessionId === session.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2
                            className="h-3 w-3"
                            onClick={() => handleDeleteSession(session)}
                          />
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
        <SidebarFooter className="border-t p-3">
          <div className="relative">
            <Button
              variant="ghost"
              className={`w-full justify-start rounded-lg font-medium ${
                isCollapsed ? 'px-0 justify-center' : ''
              }`}
              onClick={() => setSettingsMenuOpen(!settingsMenuOpen)}
            >
              <Settings className={`h-5 w-5 ${!isCollapsed && 'mr-2'}`} />
              {!isCollapsed && '设置'}
            </Button>

            {/* Settings Menu */}
            {settingsMenuOpen && !isCollapsed && (
              <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border bg-popover p-2 shadow-lg">
                <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">
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
              </div>
            )}
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
        <div
          className="fixed inset-0 z-40"
          onClick={() => setSettingsMenuOpen(false)}
        />
      )}
    </>
  );
}
