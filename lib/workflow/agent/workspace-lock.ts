'use step';

import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('workspace-lock');

/**
 * Workspace run-lock acquire/release.
 *
 * One workflow run (an "execution session") holds the per-workspace lock
 * for the duration of its tool calls so two concurrent runs in the same
 * long-lived LXC container can't interleave commands. The lock lives in
 * agentd memory; Web `workspaces.node_generation` is the fencing token.
 *
 * Contract (mirrors the agentd HTTP endpoints):
 *   acquire → 200 (got it) | 409 busy (another run holds it)
 *   release → always best-effort, no-op if not held
 *
 * On 409 busy, the caller (chatWorkflow) falls back to short-lived
 * containers for this run — the LLM gets a stateless environment this
 * turn. That's an explicit product choice: we never block waiting.
 */

interface AcquireResult {
  acquired: boolean;
  /** Present when acquired (generation token + holder info). */
  state?: {
    workspace_id: string;
    holder_type: string;
    exec_session_id: string;
    owner_task_id?: string;
    node_generation: number;
    acquired_at: string;
    expires_at: string;
  };
  /** Present when busy — the current holder, for telemetry only. */
  holder?: unknown;
}

/**
 * Try to acquire the workspace run lock from the agentd node that owns the
 * workspace's long-lived container. Best-effort: any transport error is
 * treated as "not acquired" so a missing/unreachable agentd never blocks
 * the run — short-lived containers still work without a lock.
 */
export async function acquireWorkspaceLock(input: {
  nodeId: string;
  workspaceId: string;
  execSessionId: string;
  holderType?: string;
  ownerTaskId?: string;
  ttlSeconds?: number;
  nodeGeneration: number;
}): Promise<AcquireResult> {
  const {
    nodeId,
    workspaceId,
    execSessionId,
    holderType = 'chat_run',
    ownerTaskId,
    ttlSeconds = 30 * 60,
    nodeGeneration,
  } = input;

  if (!workspaceId || !execSessionId) {
    return { acquired: false };
  }

  try {
    const { getAgentdClientConfigByNodeId } = await import(
      '@/lib/extra/agent/agentd-tools-client'
    );
    const { requestAgentd } = await import('@/lib/extra/agent/agentd-http');
    const config = await getAgentdClientConfigByNodeId(nodeId);
    if (!config) {
      logger.warn('acquire: node not found', { nodeId, workspaceId });
      return { acquired: false };
    }
    const res = await requestAgentd(
      config,
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/lock/acquire`,
      {
        exec_session_id: execSessionId,
        holder_type: holderType,
        owner_task_id: ownerTaskId,
        ttl_seconds: ttlSeconds,
        node_generation: nodeGeneration,
      },
      10_000,
    );
    if (res.status === 200) {
      const data = JSON.parse(res.text || '{}') as Record<string, unknown>;
      return { acquired: true, state: data.data as AcquireResult['state'] };
    }
    if (res.status === 409) {
      const data = JSON.parse(res.text || '{}') as Record<string, unknown>;
      return { acquired: false, holder: data.holder };
    }
    logger.warn('acquire unexpected status', {
      nodeId,
      workspaceId,
      status: res.status,
    });
    return { acquired: false };
  } catch (error) {
    logger.warn('acquire failed (transport)', {
      nodeId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { acquired: false };
  }
}

/**
 * Release the workspace run lock. Best-effort: a missed release is
 * recovered by the lock's TTL on the agentd side, so never throw here.
 */
export async function releaseWorkspaceLock(input: {
  nodeId: string;
  workspaceId: string;
  execSessionId: string;
}): Promise<void> {
  const { nodeId, workspaceId, execSessionId } = input;
  if (!workspaceId || !execSessionId) return;
  try {
    const { getAgentdClientConfigByNodeId } = await import(
      '@/lib/extra/agent/agentd-tools-client'
    );
    const { requestAgentd } = await import('@/lib/extra/agent/agentd-http');
    const config = await getAgentdClientConfigByNodeId(nodeId);
    if (!config) return;
    await requestAgentd(
      config,
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/lock/release`,
      { exec_session_id: execSessionId },
      10_000,
    );
  } catch (error) {
    logger.warn('release failed (non-fatal; TTL will reclaim)', {
      nodeId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── chatWorkflow integration helpers ────────────────────────────────

/**
 * Opaque handle returned by {@link acquireRunLockStep} and consumed by
 * {@link releaseRunLockStep}. An empty handle (null fields) means "no lock
 * was acquired" and release is a no-op — the run falls back to the legacy
 * short-lived-container path.
 */
export interface RunLockHandle {
  nodeId: string | null;
  workspaceId: string | null;
  execSessionId: string | null;
}

/**
 * Read the session's workspace + preferred node and try to acquire the
 * per-workspace run lock. Returns a handle that releaseRunLockStep consumes.
 *
 * Designed to never throw: any error (no workspace, no preferred node,
 * unreachable agentd, busy) degrades to an empty handle so the run still
 * proceeds with short-lived containers. This is the product contract —
 * we never block waiting for the lock.
 */
export async function acquireRunLockStep(
  sessionId: string,
  runId: string,
): Promise<RunLockHandle> {
  const empty: RunLockHandle = {
    nodeId: null,
    workspaceId: null,
    execSessionId: null,
  };
  if (!sessionId || !runId) return empty;
  try {
    const { db } = await import('@/lib/core/db');
    const { sessions, workspaces } = await import('@/lib/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const [sessionRow] = await db
      .select({
        workspaceId: sessions.workspaceId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const wsId = sessionRow?.workspaceId
      ? String(sessionRow.workspaceId)
      : null;
    if (!wsId) return empty;
    const [wsRow] = await db
      .select({
        preferredNodeId: workspaces.preferredNodeId,
        nodeGeneration: workspaces.nodeGeneration,
      })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .limit(1);
    const nodeId = wsRow?.preferredNodeId ?? null;
    if (!nodeId) return empty;
    const result = await acquireWorkspaceLock({
      nodeId,
      workspaceId: wsId,
      execSessionId: runId,
      nodeGeneration: wsRow?.nodeGeneration ?? 1,
    });
    if (!result.acquired) {
      logger.info('workspace lock busy; falling back to ephemeral', {
        sessionId,
        runId,
        workspaceId: wsId,
      });
      return empty;
    }
    return { nodeId, workspaceId: wsId, execSessionId: runId };
  } catch (error) {
    logger.warn('acquireRunLockStep failed (non-fatal)', {
      sessionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

/**
 * Release a previously acquired run lock. No-op for an empty handle.
 */
export async function releaseRunLockStep(handle: RunLockHandle): Promise<void> {
  if (!handle.nodeId || !handle.workspaceId || !handle.execSessionId) return;
  await releaseWorkspaceLock({
    nodeId: handle.nodeId,
    workspaceId: handle.workspaceId,
    execSessionId: handle.execSessionId,
  });
}
