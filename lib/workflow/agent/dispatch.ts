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
import type { ClientSpoof } from '@/types/config/ai';
import type {
  ChatHookPayload,
  ChatSource,
  ToolApprovalPayload,
} from '@/types/workflow';
import type { ModelMessage } from 'ai';
import { and, eq, gte } from 'drizzle-orm';
import { getRun, start } from 'workflow/api';
import { ACTIVE_RUN_STATUSES } from './config';
import {
  approvalHookBuilder,
  instructionHookBuilder,
  localToolResultHookBuilder,
} from './hooks';
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
 * Hard load thresholds. A node is rejected ( scorer skips it, affinity
 * short-circuit falls through ) when CPU is saturated, or free memory /
 * free disk drops at-or-below the cutoff. These values MUST stay in
 * sync between the affinity branch and the scoring loop in
 * `selectBestNode` — both call this helper so they cannot drift.
 *
 * Normalized inputs: cpu/mem/disk are fractions in [0, 1]:
 *   - cpu   = cpuUsage / 100          (higher = busier)
 *   - mem   = memAvail  / 100         (higher = more free)
 *   - disk  = diskAvail / 100         (higher = more free)
 */
const CPU_SATURATION = 0.9;
const MEM_FLOOR = 0.1;
const DISK_FLOOR = 0.1;

function isNodeHealthy(cpu: number, mem: number, disk: number): boolean {
  return cpu < CPU_SATURATION && mem > MEM_FLOOR && disk > DISK_FLOOR;
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
 * Session affinity: when `affinityNodeId` is supplied AND that node
 * still passes the online/sandbox/allowlist/hard-threshold filters,
 * it is returned immediately without running the score race. This
 * lets a chat session reuse the same daemon across consecutive tool
 * calls (preserving any warmed state — git clones, npm installs,
 * browser sessions) instead of being re-dispatched to whichever node
 * happens to be lightly loaded. Affinity is strictly best-effort:
 * if the prior node is offline, missing the sandbox type, outside
 * the allowlist, or over the hard load threshold, the normal scoring
 * path runs and the affinity hint is silently replaced.
 *
 * Returns null if no node is available → caller should fall back to Vercel Sandbox.
 */
export async function selectBestNode(
  requiredSandbox?: string,
  allowedNodes?: readonly string[],
  affinityNodeId?: string,
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

    // Session affinity: if the caller named a previously-used node
    // and it survived the filters above, confirm it also clears the
    // same hard load thresholds as the scoring path (cpu/mem/disk),
    // then short-circuit. Going through the same hard-cutoff check
    // guarantees affinity never parks a session on a node the
    // scorer would have rejected.
    if (affinityNodeId) {
      const affinityNode = filtered.find(
        (n: Row) => n.nodeID === affinityNodeId,
      );
      if (affinityNode) {
        const cpu =
          affinityNode.cpuUsage != null ? affinityNode.cpuUsage / 100 : 0.5;
        const mem =
          affinityNode.memAvail != null ? affinityNode.memAvail / 100 : 0.5;
        const disk =
          affinityNode.diskAvail != null ? affinityNode.diskAvail / 100 : 0.5;
        if (isNodeHealthy(cpu, mem, disk)) {
          return {
            nodeID: affinityNode.nodeID,
            ip: affinityNode.ip,
            port: affinityNode.port,
            sandboxes: (affinityNode.sandboxes as string[]) || [],
            cpuUsage: affinityNode.cpuUsage,
            memAvail: affinityNode.memAvail,
            diskAvail: affinityNode.diskAvail,
            activeTasks: affinityNode.activeTasks || 0,
            sandboxMemPeakTotal: affinityNode.sandboxMemPeakTotal,
          };
        }
      }
    }

    const scored: { node: Row; score: number }[] = [];
    for (const n of filtered) {
      const cpu = n.cpuUsage != null ? n.cpuUsage / 100 : 0.5;
      const mem = n.memAvail != null ? n.memAvail / 100 : 0.5;
      const disk = n.diskAvail != null ? n.diskAvail / 100 : 0.5;

      // Skip overloaded nodes
      if (!isNodeHealthy(cpu, mem, disk)) continue;

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

    // Second check: is the selected daemon actually responding?
    // Probe the same node we just picked (not nodes[0]) so a
    // multi-node install returns a verdict driven by the node that
    // would actually receive the dispatch.
    const healthy = await checkAgentdHealth({
      nodeID: node.nodeID,
      ip: node.ip,
      port: node.port,
    });
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
  /**
   * Merged AGENTS.md content forwarded by the CLI host and persisted on
   * session.metadata. chatWorkflow forwards it to buildSystemPrompt, which
   * injects it as project-supplied reference data (CLI sources only).
   */
  agentsMd?: string;
  /**
   * Plan mode toggle from the CLI `/plan` command. Forwarded to
   * chatWorkflow → buildAgentTools, which filters the toolset to
   * read-only / observe / reason tools only. False / undefined = normal
   * execution mode.
   */
  planMode?: boolean;
  /**
   * Thinking level from the CLI `/effort` command. Forwarded to
   * chatWorkflow → resolveAgentProviderOptions, which serializes it
   * into the matching provider-specific reasoning field. 'off' /
   * undefined leaves the provider's default behavior unchanged.
   */
  thinkingLevel?: string;
  /**
   * Experimental client-spoof profile from CLI/Desktop settings. Forwarded
   * to chatWorkflow so it can override provider config for this run.
   */
  clientSpoof?: ClientSpoof;
  /**
   * Per-message agent/persona name from the Web UI preset picker.
   * Forwarded to chatWorkflow, which validates it against config.agents
   * and overrides MAIN_AGENT_NAME for this run when it matches. See
   * chatWorkflow's param docs.
   */
  requestAgent?: string | null;
}): Promise<{
  runId: string;
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
      input.agentsMd,
      input.planMode,
      input.thinkingLevel,
      input.clientSpoof,
      input.requestAgent,
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

  // Fire-and-forget: POST /api/ai returns immediately with just the
  // runId; the client subscribes to the run's stream via the separate
  // GET /api/ai/[runId]/stream endpoint (which calls getWorkflowRun).
  //
  // We deliberately do NOT read run.readable here. The workflow SDK's
  // step execution is driven by the Vercel Queue Service (not by this
  // stream's consumer — see node_modules/@workflow/core/dist/runtime.js
  // workflowEntrypoint), so leaving the stream unread does not stall
  // the run. Post-run finalization (memory extraction, skill
  // distillation, resource cleanup) runs in a SEPARATE workflow run
  // (postRunCleanupWorkflow) spawned fire-and-forget from chatWorkflow
  // after it closes its UI stream, so it no longer depends on a
  // long-lived HTTP function draining the stream either.
  return {
    runId: run.runId,
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
    ...(payload.label ? { label: payload.label } : {}),
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

/**
 * Request an explicit named checkpoint. Equivalent to requestCompact but
 * stamps `label` onto the resulting session_memories row metadata so the
 * UI can surface it as a user-named restore point rather than an
 * anonymous auto-compaction. Returns false when the run can't be resumed
 * (already closed, etc.) — same contract as requestCompact.
 */
export async function requestCheckpoint(
  runId: string,
  label?: string,
): Promise<boolean> {
  if (!(await canResumeRun(runId))) {
    return false;
  }

  await resumeWithMessage(runId, {
    type: 'control',
    command: 'checkpoint',
    ...(label ? { label } : {}),
  });

  return true;
}

export async function resumeToolApproval(
  toolCallId: string,
  payload: ToolApprovalPayload,
): Promise<void> {
  await approvalHookBuilder.resume(toolCallId, payload);
}

/**
 * Resume a `local_*` tool execute that is blocked on
 * `localToolResultHookBuilder.create({ token: toolCallId })`. Called by
 * the POST /api/ai/[runId]/tool-result route after the CLI client
 * finishes executing the tool against the user's filesystem.
 */
export async function resumeLocalToolResult(
  toolCallId: string,
  payload: { ok: boolean; output?: unknown; error?: string },
): Promise<void> {
  await localToolResultHookBuilder.resume(toolCallId, payload);
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
