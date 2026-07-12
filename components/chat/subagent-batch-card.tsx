'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

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
  const [data, setData] = useState<SubagentBatchData | null>(
    initialData ?? null,
  );
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (initialData) return;

    let cancelled = false;
    async function fetchBatch() {
      try {
        const resp = await fetch(`/api/cli/subagent-batch/${batchId}`);
        const json = await resp.json();
        if (!cancelled && json.ok) {
          setData(json.data);
        }
      } catch {
        // silent
      }
    }
    fetchBatch();
    const interval = setInterval(fetchBatch, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [batchId, initialData]);

  if (!data) {
    return (
      <div className="my-2 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
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
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium transition-colors hover:bg-muted/30"
      >
        <span className="text-[#6d9ec3]">⊞</span>
        <span className="flex-1">
          Subagent Batch · {total} agent{total !== 1 ? 's' : ''}
        </span>
        <span className="text-xs text-muted-foreground">
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
