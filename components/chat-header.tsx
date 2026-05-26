'use client';

import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { checkAgentdHealth } from '@/lib/extra/agent/agentd-tools-client';

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
  const [aborting, setAborting] = useState(false);

  const status = session?.status ?? 'idle';
  const isRunning = status === 'running' || status === 'waiting_user';
  const [agentdStatus, setAgentdStatus] = useState<'online' | 'offline' | 'checking'>('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const healthy = await checkAgentdHealth();
        if (!cancelled) setAgentdStatus(healthy ? 'online' : 'offline');
      } catch {
        if (!cancelled) setAgentdStatus('offline');
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const handleAbort = useCallback(async () => {
    if (!chatId) return;
    setAborting(true);
    try {
      await fetch(`/api/agentd/v1/sessions/${chatId}/abort`, {
        method: 'POST',
      });
      toast.success('Session aborted');
      onAbort?.();
    } catch {
      toast.error('Failed to abort session');
    } finally {
      setAborting(false);
    }
  }, [chatId, onAbort]);

  const sessionDetails = session
    ? [
        {
          label: 'Channel',
          value: session.channel,
          valueClassName: 'text-foreground',
        },
        ...(session.externalThreadId
          ? [
              {
                label: 'External Thread',
                value: session.externalThreadId,
                valueClassName: 'break-all font-mono text-foreground',
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
    <header className="sticky top-0 z-20 border-b bg-background/95 px-2 py-2 backdrop-blur md:px-3">
      <div className="flex items-start gap-2">
        {session ? (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {session.title ?? 'Untitled Session'}
              </h1>
              {/* Status indicator */}
              {isRunning && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 shrink-0">
                  <Loader2 className="size-3 animate-spin" />
                  {status === 'waiting_user' ? 'Waiting' : 'Running'}
                </span>
              )}
              {status === 'completed' && (
                <span className="inline-flex items-center gap-1 text-xs text-green-600 shrink-0">
                  ✓ Done
                </span>
              )}
              {status === 'aborted' && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  ⏹ Aborted
                </span>
              )}
              {/* Agent Daemon status */}
              {agentdStatus === 'online' && (
                <span className="inline-flex items-center gap-1 text-xs text-green-600 shrink-0" title="Agent Daemon online — full security review active">
                  <span className="size-1.5 rounded-full bg-green-500" />
                  AgentD
                </span>
              )}
              {agentdStatus === 'offline' && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 shrink-0" title="Agent Daemon offline — using Vercel Sandbox (limited security)">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  Sandbox
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {sessionDetails.map(({ label, value, valueClassName }) => (
                <span
                  key={label}
                  className="inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 leading-5"
                >
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
                    {label}
                  </span>
                  <span className={`min-w-0 ${valueClassName}`}>{value}</span>
                </span>
              ))}
              {tokenDisplay && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  🪙 {tokenDisplay}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <div className="flex items-center gap-1 shrink-0">
          {/* Abort button — only when running */}
          {isRunning && chatId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="shrink-0 px-2 md:h-fit text-red-600 hover:text-red-700 hover:bg-red-50"
                  aria-label="Abort session"
                  onClick={handleAbort}
                  disabled={aborting}
                >
                  {aborting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <SquareIcon />
                  )}
                  <span className="hidden md:inline">Abort</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Abort Session</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="shrink-0 px-2 md:h-fit"
                aria-label="New chat"
                onClick={() => {
                  router.push('/');
                  router.refresh();
                }}
              >
                <PlusIcon />
                <span className="hidden md:inline">New Chat</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>New Chat</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
