import { db } from '@/lib/core/db';
import {
  getSession,
  getSessionByWorkflowRunId,
  updateSession,
} from '@/lib/core/db/chat';
import { agentdNodes } from '@/lib/core/db/schema';
import { nowIso, patchWorkflowRuntime } from '@/lib/core/sandbox/runtime';
import { checkAgentdHealth } from '@/lib/extra/agent/agentd-tools-client';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type {
  ChatHookPayload,
  ChatSource,
  ToolApprovalPayload,
  WorkflowUIMessageChunk,
} from '@/types/workflow';
import type { ModelMessage } from 'ai';
import { and, eq, gte } from 'drizzle-orm';
import { getRun, start } from 'workflow/api';
import { ACTIVE_RUN_STATUSES } from './config';
import { approvalHookBuilder, instructionHookBuilder } from './hooks';
import { chatWorkflow } from './index';

export interface AgentNodeStatus {
  nodeID: string;
  ip: string;
  port: number;
  sandboxes: string[];
  cpuUsage: number | null;
  memAvail: number | null;
  diskAvail: number | null;
  activeTasks: number;
  /**
   * P3.3: aggregated peak memory across all active sandboxes on the
   * node (bytes). Null when no cgroup data was reported (cgroup v1
   * host, no active sandboxes). Used by selectBestNode as a soft
   * signal that a node is closer to its memory ceiling than
   * memAvail alone suggests.
   */
  sandboxMemPeakTotal: number | null;
}

/**
 * selectBestNode finds the best Agent Daemon node based on:
 * 1. Online status (heartbeat within 2 minutes)
 * 2. Required sandbox type availability
 * 3. Per-agent allowed_nodes filter (P3.1)
 * 4. Resource score: CPU (35%) + memory (35%) + disk (20%) + active load (10%)
 * 5. Active tasks (tiebreaker)
 *
 * P3.1: `allowedNodes` narrows the candidate pool to the agent's
 * configured node allowlist. Empty/undefined = any node.
 *
 * Returns null if no node is available → caller should fall back to Vercel Sandbox.
 */
export async function selectBestNode(
  requiredSandbox?: string,
  allowedNodes?: readonly string[],
): Promise<AgentNodeStatus | null> {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    const rows = await db
      .select()
      .from(agentdNodes)
      .where(
        and(
          eq(agentdNodes.status, 'online'),
          gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
        ),
      );

    if (rows.length === 0) return null;

    type Row = (typeof rows)[0];

    // P3.1: apply per-agent allowed_nodes filter first.
    let filtered: Row[] = rows;
    if (allowedNodes && allowedNodes.length > 0) {
      const allow = new Set(allowedNodes);
      filtered = rows.filter((n: Row) => allow.has(n.nodeID));
      if (filtered.length === 0) return null;
    }

    // Sandbox-type filter.
    filtered = requiredSandbox
      ? filtered.filter((n: Row) => {
          const sbs = n.sandboxes as string[] | null;
          return sbs ? sbs.includes(requiredSandbox) : false;
        })
      : filtered;

    if (filtered.length === 0) return null;

    const scored: { node: Row; score: number }[] = [];
    for (const n of filtered) {
      const cpu = n.cpuUsage != null ? n.cpuUsage / 100 : 0.5;
      const mem = n.memAvail != null ? n.memAvail / 100 : 0.5;
      const disk = n.diskAvail != null ? n.diskAvail / 100 : 0.5;

      // Skip overloaded nodes
      if (cpu >= 0.9 || mem <= 0.1 || disk <= 0.1) continue;

      // P3.1: add a small active-tasks penalty so a busy node loses
      // to an idle one even when their CPU/mem look similar. The
      // penalty saturates at 10 active tasks.
      const baseLoad =
        Math.min((n.activeTasks ?? 0) + (n.activeSandboxes ?? 0), 10) / 10;

      // P3.3: per-sandbox memory pressure from cgroup v2 samples.
      // peak >= 1GB starts penalizing, peak >= 8GB saturates. This
      // catches the case where a node reports healthy host-level
      // memAvail but its sandboxes are sitting near the cgroup memory
      // limit — the next allocation is more likely to push them into
      // reclaim. Null (no cgroup data) = no penalty.
      const peakBytes = n.sandboxMemPeakTotal ?? 0;
      const memPressure = Math.min(Math.max(peakBytes / (8 * 1024 ** 3), 0), 1);

      const activeLoad = Math.min(baseLoad + memPressure * 0.5, 1);
      const score =
        (1 - cpu) * 0.35 + mem * 0.35 + disk * 0.2 + (1 - activeLoad) * 0.1;
      scored.push({ node: n, score });
    }

    if (scored.length === 0) return null;

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.node.activeTasks ?? 0) - (b.node.activeTasks ?? 0);
    });

    const best = scored[0].node;
    return {
      nodeID: best.nodeID,
      ip: best.ip,
      port: best.port,
      sandboxes: (best.sandboxes as string[]) || [],
      cpuUsage: best.cpuUsage,
      memAvail: best.memAvail,
      diskAvail: best.diskAvail,
      activeTasks: best.activeTasks || 0,
      sandboxMemPeakTotal: best.sandboxMemPeakTotal,
    };
  } catch {
    return null;
  }
}

/**
 * isAgentdAvailable checks if any Agent Daemon node is online and healthy.
 * Used by tools to decide whether to route through Agent Daemon or fall back to Vercel Sandbox.
 */
export async function isAgentdAvailable(): Promise<boolean> {
  try {
    // First check: is there an online node in DB?
    const node = await selectBestNode();
    if (!node) return false;

    // Second check: is the daemon actually responding?
    const healthy = await checkAgentdHealth();
    return healthy;
  } catch {
    return false;
  }
}

export async function startWorkflow(input: {
  sessionId: string;
  initialMessages: ModelMessage[];
  config: AppConfig;
  source: ChatSource;
  user?: {
    modelPreferences?: { model?: string } | null;
  } | null;
  /**
   * Per-message model override from the chat-box picker. Forwarded as the
   * last positional arg to `chatWorkflow`. See `chatWorkflow`'s param docs.
   */
  requestModel?: string | null;
}): Promise<{
  runId: string;
  readable: ReadableStream<WorkflowUIMessageChunk>;
}> {
  const logger = createLogger('workflow.dispatch');
  logger.info('startWorkflow:start', { sessionId: input.sessionId });

  const WORKFLOW_START_TIMEOUT_MS = 30000;

  logger.info('startWorkflow:calling_sdk_start');
  const startWithTimeout = Promise.race([
    start(chatWorkflow, [
      input.initialMessages,
      input.source,
      input.config,
      input.sessionId,
      input.user,
      input.requestModel,
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Workflow start timed out after ${WORKFLOW_START_TIMEOUT_MS}ms`,
            ),
          ),
        WORKFLOW_START_TIMEOUT_MS,
      ),
    ),
  ]);

  logger.info('startWorkflow:awaiting_run');
  const run = await startWithTimeout;
  logger.info('startWorkflow:run_obtained', { runId: run.runId });

  await updateSession(input.sessionId, {
    workflowRunId: run.runId,
    status: 'active',
    metadata: {
      // Merge with existing metadata — updateSession overwrites the whole
      // jsonb column, so a bare `{ source }` would wipe `locale` (set via
      // /lang) and other fields (contextUsage, latestApproval, …). This
      // was the root cause of IM users' language resetting to English
      // after every message (which calls startWorkflow).
      ...(await getSession(input.sessionId)).metadata,
      source: input.source,
    },
  });
  logger.info('startWorkflow:session_updated');

  await patchWorkflowRuntime(input.sessionId, {
    phase: 'running',
    lastRunId: run.runId,
    startedAt: nowIso(),
    stoppedAt: null,
    lastError: null,
  });
  logger.info('startWorkflow:runtime_patched');

  // P3 follow-up: drain afterResponse() callbacks when the workflow's
  // readable stream closes. This replaces next/server's after(), which
  // can't be imported into the workflow bundle (vm.Script sandbox
  // doesn't define __dirname — see lib/workflow/agent/after-response.ts).
  // The original stream is tee'd so we don't consume it: the caller
  // still gets to read branch [0] (returned below), and our branch [1]
  // is used only to detect close.
  const [primaryStream, drainStream] = run.readable.tee();
  // Fire-and-forget: when our branch closes, run the queued callbacks.
  // Errors are caught inside drainPendingAfterCallbacks.
  void (async () => {
    try {
      const reader = drainStream.getReader();
      // Read until the stream closes (done becomes true). We discard
      // the chunks — they're already going to the real consumer via
      // primaryStream returned below.
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Stream errored — still try to drain so callbacks aren't lost.
    }
    try {
      const { drainPendingAfterCallbacks } = await import('./after-response');
      await drainPendingAfterCallbacks();
    } catch {
      // Don't let drain failures escape into an unhandled promise.
    }
    // Cleanup resources after workflow completes.
    // Sandbox is kept running (allows reuse in subsequent messages).
    try {
      const { cleanupWorkflowResources } = await import('./cleanup');
      await cleanupWorkflowResources({
        sessionId: input.sessionId,
        stopSandbox: false,
      });
    } catch {
      // Don't let cleanup failures escape into an unhandled promise.
    }
  })();

  return {
    runId: run.runId,
    readable: primaryStream,
  };
}

export async function resumeWithMessage(
  runId: string,
  payload: ChatHookPayload,
): Promise<void> {
  if (payload.type === 'user-message') {
    await instructionHookBuilder.resume(runId, {
      type: 'user',
      message: payload.message,
      parts: payload.parts,
      uiMessageId: payload.uiMessageId,
    });
    return;
  }

  if (payload.type === 'system-message') {
    await instructionHookBuilder.resume(runId, {
      type: 'system',
      message: payload.message,
    });
    return;
  }

  await instructionHookBuilder.resume(runId, {
    type: 'control',
    command: payload.command,
    reason: payload.reason,
  });
}

export async function requestCompact(runId: string): Promise<boolean> {
  if (!(await canResumeRun(runId))) {
    return false;
  }

  await resumeWithMessage(runId, {
    type: 'control',
    command: 'compact',
  });

  return true;
}

export async function resumeToolApproval(
  toolCallId: string,
  payload: ToolApprovalPayload,
): Promise<void> {
  await approvalHookBuilder.resume(toolCallId, payload);
}

export function getWorkflowRun(runId: string) {
  return getRun(runId);
}

export async function getWorkflowStatus(
  runId: string | null,
): Promise<string | null> {
  if (!runId) {
    return null;
  }

  try {
    return await getRun(runId).status;
  } catch {
    return null;
  }
}

export async function canResumeRun(runId: string): Promise<boolean> {
  const status = await getWorkflowStatus(runId);
  return status ? ACTIVE_RUN_STATUSES.has(status) : false;
}

export async function pauseWorkflow(runId: string): Promise<void> {
  await getRun(runId).cancel();

  const session = await getSessionByWorkflowRunId(runId);
  if (!session) {
    return;
  }

  await updateSession(session.id, {
    workflowRunId: null,
    status: 'stopped',
  });
  await patchWorkflowRuntime(session.id, {
    phase: 'cancelled',
    lastRunId: runId,
    stoppedAt: nowIso(),
  });
}
