'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseWithFallback } from '@/lib/core/api/schema';
import { cn } from '@/lib/utils';
import { z } from 'zod';

interface SubagentJob {
  subagent_id: string;
  agent_name: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  error?: string;
  steps?: number;
}

interface SubagentBatchData {
  batch_id: string;
  status: string;
  concurrency_limit: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  jobs: SubagentJob[];
}

/**
 * Lenient schema for GET /api/cli/subagent-batch/:id. Statuses are kept
 * as z.string() so an unknown server value still parses; the return
 * type is anchored to the fallback SubagentBatchData | null, not
 * z.infer. Guards against a drifted response (installed CLI/Desktop
 * talking to a newer backend) white-screening the card.
 */
const subagentBatchSchema = z.object({
  ok: z.boolean().optional(),
  data: z
    .object({
      batch_id: z.string(),
      status: z.string(),
      concurrency_limit: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      cancelled: z.number(),
      jobs: z.array(
        z.object({
          subagent_id: z.string(),
          agent_name: z.string(),
          task: z.string(),
          status: z.string(),
          summary: z.string().optional(),
          error: z.string().optional(),
          steps: z.number().optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
});

interface SubagentBatchCardProps {
  batchId: string;
  sessionId: string;
  initialData?: SubagentBatchData;
}

const statusColors: Record<string, string> = {
  queued: 'text-muted-foreground',
  running: 'text-blue-500',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  cancelled: 'text-muted-foreground',
};

const statusIcons: Record<string, string> = {
  queued: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
  cancelled: '—',
};

function SubagentJobRow({
  job,
  sessionId,
}: {
  job: SubagentJob;
  sessionId: string;
}) {
  const handleClick = useCallback(() => {
    const url = `/chat/${sessionId}/subagent/${job.subagent_id}`;
    window.open(url, '_blank');
  }, [sessionId, job.subagent_id]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50"
    >
      <span className={cn('shrink-0', statusColors[job.status])}>
        {job.status === 'running' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          statusIcons[job.status] || '?'
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {job.agent_name}: {job.task}
      </span>
      <span className={cn('shrink-0 text-xs', statusColors[job.status])}>
        [{job.status}]
      </span>
      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export const SubagentBatchCard = memo(function SubagentBatchCard({
  batchId,
  sessionId,
  initialData,
}: SubagentBatchCardProps) {
  // Poll the batch status. Replaces a hand-rolled useEffect + fetch +
  // setInterval + cancelled-flag with useQuery's refetchInterval. The
  // initialData (hydrated from the server component) seeds the cache so
  // the card renders immediately on mount, then refetches every 5s to
  // track job progress until the batch terminates.
  const { data } = useQuery<SubagentBatchData | null>({
    queryKey: ['subagent-batch', batchId],
    queryFn: async () => {
      const resp = await fetch(`/api/cli/subagent-batch/${batchId}`);
      if (!resp.ok) return null;
      const json = await resp.json().catch(() => null);
      const parsed = parseWithFallback(
        json,
        subagentBatchSchema,
        { ok: false, data: null },
        { endpoint: `GET /api/cli/subagent-batch/${batchId}` },
      );
      if (!parsed.ok || !parsed.data) return null;
      // Cast through unknown: the schema is lenient (status as string),
      // but the component expects the narrower union. The data came from
      // our own server so the cast is safe at runtime.
      return parsed.data as unknown as SubagentBatchData;
    },
    refetchInterval: (query) => {
      // Stop polling once the batch is terminal — no point hammering the
      // endpoint after all jobs are done.
      const d = query.state.data as SubagentBatchData | null | undefined;
      if (
        d &&
        (d.status === 'completed' ||
          d.status === 'failed' ||
          d.status === 'cancelled')
      ) {
        return false;
      }
      return 5000;
    },
    initialData: initialData ?? undefined,
  });
  const [expanded, setExpanded] = useState(true);

  if (!data) {
    return (
      <div className="my-2 rounded-lg border bg-card px-4 py-3 text-muted-foreground text-sm">
        <Loader2 className="mr-2 inline size-3.5 animate-spin" />
        Loading subagent batch…
      </div>
    );
  }

  const total = data.jobs.length;
  const running = data.jobs.filter((j) => j.status === 'running').length;
  const completed = data.succeeded;
  const failed = data.failed;

  return (
    <div className="my-2 rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left font-medium text-sm transition-colors hover:bg-muted/30"
      >
        <span className="text-[#6d9ec3]">⊞</span>
        <span className="flex-1">
          Subagent Batch · {total} agent{total !== 1 ? 's' : ''}
        </span>
        <span className="text-muted-foreground text-xs">
          {completed > 0 && `${completed} done`}
          {failed > 0 && ` · ${failed} failed`}
          {running > 0 && ` · ${running} running`}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t px-2 py-1">
          {data.jobs.map((job) => (
            <SubagentJobRow
              key={job.subagent_id}
              job={job}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
});
