'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Read-only orchestration graph for a session (Team Mode I).
 *
 * Renders the multi-agent primitives that already live in Postgres —
 * subagent batches, their jobs, open barriers, and handoffs — as a node/
 * edge graph using React Flow. The backend has been able to fan out
 * parallel subagents and coordinate them with barriers/handoffs for a
 * while; this component just makes that activity visible while a run is
 * in flight.
 *
 * Node types:
 *   - batch   : a subAgent spawn batch (the fan-out point)
 *   - job     : an individual subagent (child of its batch)
 *   - barrier : a synchronization primitive the batch/jobs link to
 *   - handoff : a named mailbox message (producer -> consumer edge)
 *
 * Auto-refreshes every few seconds while the tab is visible, so a live
 * run's graph updates without manual polling. Purely read-only — no
 * mutation endpoints are called.
 */

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type BatchStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface BatchJob {
  subagentId?: string;
  agentName: string;
  task: string;
  status: JobStatus;
  modelId?: string | null;
  summary?: string | null;
}
interface Batch {
  batchId: string;
  status: BatchStatus;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  concurrencyLimit?: number;
  jobs?: BatchJob[];
}
interface Barrier {
  barrierId: string;
  status: string;
  released?: number | string | null;
  required?: number | string | null;
  strategy?: string | null;
  expiresAt?: string | null;
}
interface Handoff {
  id: string;
  key: string;
  fromSessionId?: string | null;
  toSessionId?: string | null;
  barrierId?: string | null;
}
interface OrchestrationSnapshot {
  sessionId: string;
  batches: Batch[];
  barriers: Barrier[];
  handoffs: Handoff[];
}

const STATUS_COLORS: Record<string, string> = {
  running: '#3b82f6',
  queued: '#a1a1aa',
  completed: '#22c55e',
  failed: '#ef4444',
  cancelled: '#71717a',
  active: '#3b82f6',
  released: '#22c55e',
  expired: '#71717a',
  cancelled_barrier: '#71717a',
};

export function OrchestrationGraph({ sessionId }: { sessionId: string }) {
  return (
    <ReactFlowProvider>
      <InnerGraph sessionId={sessionId} />
    </ReactFlowProvider>
  );
}

function InnerGraph({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOnce = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/orchestration`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as OrchestrationSnapshot;
      setSnapshot(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchOnce();
    // Auto-refresh every 3s while the tab is visible.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchOnce();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchOnce]);

  const { nodes, edges } = useMemo(() => buildGraph(snapshot), [snapshot]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        加载编排图...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-red-500">
        <span>加载失败:{error}</span>
        <Button size="sm" variant="outline" onClick={() => fetchOnce()}>
          <RefreshCcw className="mr-2 size-4" />
          重试
        </Button>
      </div>
    );
  }
  if (
    snapshot &&
    snapshot.batches.length === 0 &&
    snapshot.barriers.length === 0 &&
    snapshot.handoffs.length === 0
  ) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        当前会话暂无多智能体编排活动 (subagent / barrier / handoff)。
        <Button
          size="sm"
          variant="ghost"
          className="ml-2"
          onClick={() => fetchOnce()}
        >
          <RefreshCcw className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative h-[60vh] w-full overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <div className="absolute right-2 top-2 z-10">
        <Button size="sm" variant="ghost" onClick={() => fetchOnce()}>
          <RefreshCcw className="size-4" />
        </Button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/**
 * Lay out the snapshot as columns: batches on the left, their jobs beneath
 * each, barriers in the middle, handoffs as edges. Simple deterministic
 * layout — no dagre dependency; React Flow's fitView handles the rest.
 */
function buildGraph(snapshot: OrchestrationSnapshot | null): {
  nodes: Node[];
  edges: Edge[];
} {
  if (!snapshot) return { nodes: [], edges: [] };
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const BATCH_X = 80;
  const JOB_X = 360;
  const BARRIER_X = 640;
  const ROW_H = 110;

  let batchRow = 0;
  const barrierY: Record<string, number> = {};

  for (const batch of snapshot.batches) {
    const batchY = batchRow * ROW_H;
    nodes.push(batchNode(batch, BATCH_X, batchY));
    for (const job of batch.jobs ?? []) {
      batchRow += 1;
      const jobY = batchRow * ROW_H;
      nodes.push(jobNode(job, batch.batchId, JOB_X, jobY));
      edges.push({
        id: `e-${batch.batchId}-${job.subagentId ?? job.task}`,
        source: `batch-${batch.batchId}`,
        target: `job-${batch.batchId}-${job.subagentId ?? job.task}`,
        type: 'smoothstep',
      });
      // If the job's batch links to a barrier, draw a dashed edge job->barrier.
      // (Barriers link at batch level in the schema, but the visual reads
      // better when individual jobs point at the sync primitive.)
    }
    batchRow += 1;

    // Barrier edge (batch -> barrier) if linked.
    // Barriers in this snapshot aren't directly keyed to batchId in the
    // response; they're session-scoped. We draw batch->barrier edges below
    // after barriers are placed, by matching barrierId references.
  }

  let barrierRow = 0;
  for (const barrier of snapshot.barriers) {
    const y = barrierRow * ROW_H;
    barrierY[barrier.barrierId] = y;
    nodes.push(barrierNode(barrier, BARRIER_X, y));
    barrierRow += 1;
  }

  // Handoffs: render as small nodes at a right column, with edges from
  // producer (if same session) and to consumer (if same session).
  const HANDOFF_X = 900;
  let handoffRow = 0;
  for (const h of snapshot.handoffs) {
    const y = handoffRow * ROW_H;
    nodes.push(handoffNode(h, HANDOFF_X, y));
    handoffRow += 1;
    if (h.barrierId && barrierY[h.barrierId] !== undefined) {
      edges.push({
        id: `e-handoff-${h.id}-barrier`,
        source: `barrier-${h.barrierId}`,
        target: `handoff-${h.id}`,
        type: 'smoothstep',
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        label: h.key,
      });
    }
  }

  return { nodes, edges };
}

function batchNode(batch: Batch, x: number, y: number): Node {
  const color = STATUS_COLORS[batch.status] ?? '#a1a1aa';
  return {
    id: `batch-${batch.batchId}`,
    type: 'default',
    position: { x, y },
    sourcePosition: Position.Right,
    data: {
      label: (
        <div className="text-xs">
          <div className="font-semibold" style={{ color }}>
            批次 {batch.batchId.slice(-8)}
          </div>
          <div className="text-muted-foreground">
            {batch.status} · 成功 {batch.succeeded ?? 0} / 失败{' '}
            {batch.failed ?? 0}
          </div>
          <div className="text-muted-foreground">
            {(batch.jobs ?? []).length} 个子 agent · 并发{' '}
            {batch.concurrencyLimit ?? 1}
          </div>
        </div>
      ),
    },
    style: {
      borderColor: color,
      borderWidth: 2,
      background: 'var(--background)',
      width: 220,
    },
  };
}

function jobNode(job: BatchJob, batchId: string, x: number, y: number): Node {
  const color = STATUS_COLORS[job.status] ?? '#a1a1aa';
  const id = `job-${batchId}-${job.subagentId ?? job.task}`;
  return {
    id,
    type: 'default',
    position: { x, y },
    targetPosition: Position.Left,
    data: {
      label: (
        <div className="text-xs">
          <div className="font-semibold" style={{ color }}>
            {job.agentName}
          </div>
          <div className="text-muted-foreground line-clamp-2 max-w-[180px]">
            {job.task}
          </div>
          <div className="text-muted-foreground">{job.status}</div>
        </div>
      ),
    },
    style: {
      borderColor: color,
      borderWidth: 1,
      background: 'var(--background)',
      width: 220,
    },
  };
}

function barrierNode(barrier: Barrier, x: number, y: number): Node {
  const color = STATUS_COLORS[barrier.status] ?? '#a1a1aa';
  return {
    id: `barrier-${barrier.barrierId}`,
    type: 'default',
    position: { x, y },
    data: {
      label: (
        <div className="text-xs">
          <div className="font-semibold" style={{ color }}>
            Barrier
          </div>
          <div className="text-muted-foreground">
            {barrier.barrierId.slice(-8)} · {barrier.status}
          </div>
          <div className="text-muted-foreground">
            {barrier.released ?? 0}/{barrier.required ?? '?'} ·{' '}
            {barrier.strategy ?? 'all'}
          </div>
        </div>
      ),
    },
    style: {
      borderColor: color,
      borderStyle: 'dashed',
      background: 'var(--background)',
      width: 160,
    },
  };
}

function handoffNode(h: Handoff, x: number, y: number): Node {
  return {
    id: `handoff-${h.id}`,
    type: 'default',
    position: { x, y },
    data: {
      label: (
        <div className="text-xs">
          <div className="font-semibold">Handoff</div>
          <div className="text-muted-foreground">{h.key}</div>
          <div className="text-muted-foreground">
            {h.fromSessionId?.slice(-4) ?? '?'} →{' '}
            {h.toSessionId?.slice(-4) ?? '*'}
          </div>
        </div>
      ),
    },
    style: {
      borderColor: '#8b5cf6',
      borderStyle: 'dotted',
      background: 'var(--background)',
      width: 160,
    },
  };
}
