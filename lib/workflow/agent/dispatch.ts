import { getSessionByWorkflowRunId, updateSession } from '@/lib/core/db/chat';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { nowIso, patchWorkflowRuntime } from '@/lib/core/sandbox/runtime';
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
import { checkAgentdHealth } from '@/lib/extra/agent/agentd-tools-client';

export interface AgentNodeStatus {
  nodeID: string;
  ip: string;
  port: number;
  sandboxes: string[];
  cpuUsage: number | null;
  memAvail: number | null;
  diskAvail: number | null;
  activeTasks: number;
}

/**
 * selectBestNode finds the best Agent Daemon node based on:
 * 1. Online status (heartbeat within 2 minutes)
 * 2. Required sandbox type availability
 * 3. Resource score: CPU (40%) + memory (40%) + disk (20%)
 * 4. Active tasks (tiebreaker)
 * Returns null if no node is available → caller should fall back to Vercel Sandbox.
 */
export async function selectBestNode(
  requiredSandbox?: string,
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

    const filtered: Row[] = requiredSandbox
      ? rows.filter((n: Row) => {
          const sbs = n.sandboxes as string[] | null;
          return sbs ? sbs.includes(requiredSandbox) : false;
        })
      : rows;

    if (filtered.length === 0) return null;

    const scored: { node: Row; score: number }[] = [];
    for (const n of filtered) {
      const cpu = n.cpuUsage != null ? n.cpuUsage / 100 : 0.5;
      const mem = n.memAvail != null ? n.memAvail / 100 : 0.5;
      const disk = n.diskAvail != null ? n.diskAvail / 100 : 0.5;

      // Skip overloaded nodes
      if (cpu >= 0.9 || mem <= 0.1 || disk <= 0.1) continue;

      const score = (1 - cpu) * 0.4 + mem * 0.4 + disk * 0.2;
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
}): Promise<{
  runId: string;
  readable: ReadableStream<WorkflowUIMessageChunk>;
}> {
  const run = await start(chatWorkflow, [
    input.initialMessages,
    input.source,
    input.config,
    input.sessionId,
  ]);

  await updateSession(input.sessionId, {
    workflowRunId: run.runId,
    status: 'active',
    metadata: {
      source: input.source,
    },
  });
  await patchWorkflowRuntime(input.sessionId, {
    phase: 'running',
    lastRunId: run.runId,
    startedAt: nowIso(),
    stoppedAt: null,
    lastError: null,
  });

  return {
    runId: run.runId,
    readable: run.readable,
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
