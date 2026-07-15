'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface SubagentMessage {
  role: string;
  content: string;
  tool_name?: string;
  tool_input?: string;
  is_error?: boolean;
  timestamp: number;
}

interface SubagentInfo {
  id: string;
  task: string;
  status: string;
  summary?: string;
  error?: string;
  agent_id?: string;
  session_id?: string;
}

function MessageBubble({ msg }: { msg: SubagentMessage }) {
  const isAssistant = msg.role === 'assistant';
  const isToolResult =
    msg.role === 'user' && msg.content.startsWith('[tool result:');

  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 text-sm leading-relaxed',
        isAssistant
          ? 'bg-muted/50'
          : isToolResult
            ? 'border border-dashed bg-card text-muted-foreground'
            : 'bg-primary/5',
        msg.is_error && 'border-red-500/30 bg-red-50 dark:bg-red-950/20',
      )}
    >
      <div className="mb-1 font-medium text-muted-foreground text-xs">
        {isAssistant ? 'Assistant' : isToolResult ? 'Tool Result' : 'User'}
        {msg.tool_name && (
          <span className="ml-2 text-blue-500 text-xs">[{msg.tool_name}]</span>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
    </div>
  );
}

export default function SubagentDetailPage() {
  const params = useParams<{ id: string; subagentId: string }>();
  const sessionId = params.id;
  const subagentId = params.subagentId;

  const [info, setInfo] = useState<SubagentInfo | null>(null);
  const [messages, setMessages] = useState<SubagentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const [infoResp, msgsResp] = await Promise.all([
          fetch(`/api/cli/subagent/${subagentId}`),
          fetch(`/api/cli/subagent/${subagentId}/messages`),
        ]);

        const infoJson = await infoResp.json();
        const msgsJson = await msgsResp.json();

        if (cancelled) return;

        if (infoJson.ok) setInfo(infoJson.data);
        else setError(infoJson.data?.error || 'Failed to load subagent info');

        if (msgsJson.ok && Array.isArray(msgsJson.data)) {
          setMessages(msgsJson.data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load subagent',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();

    const interval = setInterval(async () => {
      if (info?.status === 'completed' || info?.status === 'failed') return;
      try {
        const msgsResp = await fetch(
          `/api/cli/subagent/${subagentId}/messages`,
        );
        const msgsJson = await msgsResp.json();
        if (!cancelled && msgsJson.ok && Array.isArray(msgsJson.data)) {
          setMessages(msgsJson.data);
        }
        const infoResp = await fetch(`/api/cli/subagent/${subagentId}`);
        const infoJson = await infoResp.json();
        if (!cancelled && infoJson.ok) setInfo(infoJson.data);
      } catch {
        // silent poll failure
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [subagentId, info?.status]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-red-500">{error}</p>
        <Link
          href={`/chat/${sessionId}`}
          className="text-muted-foreground text-sm underline"
        >
          Back to session
        </Link>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    running: 'bg-blue-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    queued: 'bg-gray-400',
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={`/chat/${sessionId}`}
          className="mb-4 inline-flex items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to session
        </Link>

        <div className="mt-2 flex items-center gap-3">
          <div
            className={cn(
              'size-2.5 rounded-full',
              statusColors[info?.status ?? ''] ?? 'bg-gray-400',
            )}
          />
          <h1 className="font-semibold text-lg">
            Subagent: {info?.id?.slice(0, 8)}
          </h1>
          <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs capitalize">
            {info?.status}
          </span>
        </div>

        {info?.task && (
          <p className="mt-2 text-muted-foreground text-sm">{info.task}</p>
        )}

        {info?.summary && info.status === 'completed' && (
          <div className="mt-3 rounded-lg border bg-green-50 px-4 py-3 text-sm dark:bg-green-950/20">
            <div className="mb-1 font-medium text-green-700 text-xs dark:text-green-400">
              Summary
            </div>
            <div className="whitespace-pre-wrap">{info.summary}</div>
          </div>
        )}

        {info?.error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-950/20">
            <div className="mb-1 font-medium text-red-700 text-xs dark:text-red-400">
              Error
            </div>
            <div className="whitespace-pre-wrap">{info.error}</div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="font-medium text-muted-foreground text-sm">
          Conversation ({messages.length} messages)
        </h2>
        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {info?.status === 'running'
              ? 'Waiting for messages…'
              : 'No messages recorded.'}
          </p>
        ) : (
          messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)
        )}
        {info?.status === 'running' && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-3.5 animate-spin" />
            Subagent is still running…
          </div>
        )}
      </div>
    </div>
  );
}
