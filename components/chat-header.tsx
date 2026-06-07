'use client';

import { Bot, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Loader2, PlusIcon, SquareIcon } from './icons';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'aborted';

type ChatHeaderSession = {
  title: string | null;
  channel: string;
  externalThreadId: string | null;
  status?: SessionStatus;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
};

function PureChatHeader({
  session,
  chatId,
  onAbort,
}: {
  session?: ChatHeaderSession | null;
  chatId?: string;
  onAbort?: () => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [aborting, setAborting] = useState(false);

  const status = session?.status ?? 'idle';
  const isRunning = status === 'running' || status === 'waiting_user';
  const [agentdStatus, setAgentdStatus] = useState<
    'online' | 'offline' | 'checking'
  >('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch('/api/agentd/v1/health', {
          cache: 'no-store',
        });
        const payload = (await response.json()) as {
          data?: { daemon?: { status?: string } };
        };
        const healthy =
          response.ok && payload.data?.daemon?.status === 'online';
        if (!cancelled) setAgentdStatus(healthy ? 'online' : 'offline');
      } catch {
        if (!cancelled) setAgentdStatus('offline');
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleAbort = useCallback(async () => {
    if (!chatId) return;
    setAborting(true);
    try {
      const response = await fetch(`/api/agentd/v1/sessions/${chatId}/abort`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Abort request failed');
      }
      toast.success(t('chatHeader.abortSuccess'));
      onAbort?.();
    } catch {
      toast.error(t('chatHeader.abortError'));
    } finally {
      setAborting(false);
    }
  }, [chatId, onAbort, t]);

  const sessionDetails = session
    ? [
        {
          label: t('chatHeader.channel'),
          value: session.channel,
          valueClassName: 'text-foreground',
        },
        ...(session.externalThreadId
          ? [
              {
                label: t('chatHeader.externalThread'),
                value: session.externalThreadId,
                valueClassName: 'font-mono text-foreground',
              },
            ]
          : []),
      ]
    : [];

  const tokenUsage = session?.tokenUsage;
  const tokenDisplay = tokenUsage
    ? `${(tokenUsage.total / 1000).toFixed(1)}k tokens`
    : null;

  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 py-3 pr-4 pl-14 backdrop-blur md:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="font-semibold text-lg tracking-tight">
                AgentBoster
              </span>
              <span className="text-lg text-muted-foreground">ChatUI</span>
            </div>

            <div className="ml-auto hidden rounded-xl bg-muted p-1 md:grid md:grid-cols-2">
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg"
              >
                <Link href="/config/monitoring">
                  <Bot className="size-3.5" />
                  {t('nav.bot')}
                </Link>
              </Button>
              <Button size="sm" className="h-8 rounded-lg">
                <MessageSquare className="size-3.5" />
                {t('nav.chat')}
              </Button>
            </div>
          </div>

          <div className="mt-2 flex min-h-8 min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-1 text-muted-foreground text-xs [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {session ? (
              <>
                <span className="h-7 max-w-[11rem] shrink-0 truncate rounded-md bg-muted/70 px-2 font-medium text-foreground leading-7 sm:max-w-[280px]">
                  {session.title ?? t('chatHeader.untitledSession')}
                </span>
                {isRunning && (
                  <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-2 text-amber-700 dark:text-amber-300">
                    <Loader2 className="size-3 animate-spin" />
                    {status === 'waiting_user'
                      ? t('chatHeader.waiting')
                      : t('chatHeader.running')}
                  </span>
                )}
                {status === 'completed' && (
                  <span className="inline-flex h-7 shrink-0 items-center rounded-md bg-green-500/10 px-2 text-green-700 dark:text-green-300">
                    {t('chatHeader.done')}
                  </span>
                )}
                {status === 'aborted' && (
                  <span className="inline-flex h-7 shrink-0 items-center rounded-md bg-muted px-2 text-muted-foreground">
                    {t('chatHeader.aborted')}
                  </span>
                )}
                {agentdStatus === 'online' && (
                  <span
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-green-500/10 px-2 text-green-700 dark:text-green-300"
                    title={t('chatHeader.agentdOnlineTitle')}
                  >
                    <span className="size-1.5 rounded-full bg-green-500" />
                    AgentD
                  </span>
                )}
                {agentdStatus === 'offline' && (
                  <span
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-2 text-amber-700 dark:text-amber-300"
                    title={t('chatHeader.agentdOfflineTitle')}
                  >
                    <span className="size-1.5 rounded-full bg-amber-500" />
                    Sandbox
                  </span>
                )}
                {sessionDetails.map(({ label, value, valueClassName }) => (
                  <span
                    key={label}
                    className="inline-flex h-7 max-w-none shrink-0 items-center gap-1 rounded-md bg-muted px-2 leading-7"
                  >
                    <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
                      {label}
                    </span>
                    <span className={`whitespace-nowrap ${valueClassName}`}>
                      {value}
                    </span>
                  </span>
                ))}
                {tokenDisplay && (
                  <span className="inline-flex h-7 shrink-0 items-center rounded-md bg-muted px-2">
                    {t('chatHeader.tokens', { value: tokenDisplay })}
                  </span>
                )}
              </>
            ) : (
              <span className="inline-flex h-7 shrink-0 items-center rounded-md bg-muted/70 px-2">
                {t('chatHeader.startNew')}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Abort button — only when running */}
          {isRunning && chatId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="shrink-0 px-2 text-red-600 hover:bg-red-50 hover:text-red-700 md:h-fit"
                  aria-label={t('chatHeader.abortSession')}
                  onClick={handleAbort}
                  disabled={aborting}
                >
                  {aborting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <SquareIcon />
                  )}
                  <span className="hidden md:inline">
                    {t('chatHeader.abort')}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('chatHeader.abortSession')}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="shrink-0 px-2 md:h-fit"
                aria-label={t('chatHeader.newChat')}
                onClick={() => {
                  router.push('/');
                  router.refresh();
                }}
              >
                <PlusIcon />
                <span className="hidden md:inline">
                  {t('chatHeader.newChat')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chatHeader.newChat')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
