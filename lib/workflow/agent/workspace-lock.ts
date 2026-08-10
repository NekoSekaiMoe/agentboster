'use step';

import { parseWithFallback } from '@/lib/core/api/schema';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

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
 *
 * NOTE: the "fall back to ephemeral" contract is now fully implemented.
 * {@link acquireRunLockStep} returns an empty handle on busy, and the chat
 * workflow propagates `workspaceLockAcquired` (derived from the handle)
 * through buildAgentTools → the agentd tool definitions →
 * `execToolOnAgentd`. When the lock wasn't acquired, `workspace_id` is
 * suppressed in the ExecuteTool request so agentd uses a short-lived
 * ephemeral container instead of binding the long-lived workspace
 * container and serializing on its internal ExecLockFor.
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

// Lenient schemas for the agentd lock responses. Fields are kept as plain
// strings (not enums) so an unexpected value still parses; the state shape
// mirrors what the daemon returns under `data` (200) or `holder` (409).
const acquireStateSchema = z
  .object({
    data: z
      .object({
        // workspace_id + node_generation are REQUIRED: they are the core
        // lock-handle / fencing fields. A 200 response whose payload lacks
        // them fails safeParse → parseWithFallback returns the undefined
        // fallback → treated as NOT acquired (never acquired:true with a
        // half-populated state). The rest stay optional to mirror
        // AcquireResult.state's optional properties.
        workspace_id: z.string(),
        holder_type: z.string().optional(),
        exec_session_id: z.string().optional(),
        owner_task_id: z.string().optional(),
        node_generation: z.number(),
        acquired_at: z.string().optional(),
        expires_at: z.string().optional(),
      })
      .optional(),
  })
  .transform((d) => d.data);

const acquireBusySchema = z
  .object({
    data: z
      .object({
        holder: z.unknown().optional(),
      })
      .optional(),
  })
  .transform((d) => d.data ?? { holder: undefined });

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
    ttlSeconds = 2 * 60 * 60,
    // TODO(tech-debt, follow-up): default TTL is 2h, raised from the
    // original 30min so typical long agent runs don't have their workspace
    // lock silently expire mid-run (agentd's TryAcquire lets another run
    // steal the lock after expires_at, and there is no renew/heartbeat
    // path here today — two concurrent runs could then interleave commands
    // in the same container near the boundary). 2h covers the overwhelming
    // majority of runs; the proper fix is a periodic re-acquire (renewal)
    // loop driven from the host boundary while the run is active, so the
    // TTL can stay short as a leak safety-net. Tracked as a follow-up.
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
      // Validate the agentd response with a lenient schema rather than a
      // bare `as` cast: a malformed body (missing `data`) used to yield
      // `{ acquired: true, state: undefined }`, making the caller believe it
      // held a lock it never received. Treat parse failure as NOT acquired.
      const payload = parseWithFallback(
        JSON.parse(res.text || '{}'),
        acquireStateSchema,
        undefined,
        { endpoint: 'POST /api/v1/workspaces/:id/lock/acquire' },
      );
      if (!payload) {
        logger.warn('acquire: malformed 200 body, treating as not acquired', {
          nodeId,
          workspaceId,
        });
        return { acquired: false };
      }
      return { acquired: true, state: payload };
    }
    if (res.status === 409) {
      const payload = parseWithFallback(
        JSON.parse(res.text || '{}'),
        acquireBusySchema,
        { holder: undefined },
        { endpoint: 'POST /api/v1/workspaces/:id/lock/acquire (busy)' },
      );
      return { acquired: false, holder: payload.holder };
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
  /** Fencing token captured at acquire time. Sent so agentd can reject a
   *  stale release (container rebuilt / generation bumped between acquire
   *  and release). Omitted entirely when the acquire path had no
   *  generation — never send undefined/null. */
  nodeGeneration?: number | null;
}): Promise<void> {
  const { nodeId, workspaceId, execSessionId, nodeGeneration } = input;
  if (!workspaceId || !execSessionId) return;
  try {
    const { getAgentdClientConfigByNodeId } = await import(
      '@/lib/extra/agent/agentd-tools-client'
    );
    const { requestAgentd } = await import('@/lib/extra/agent/agentd-http');
    const config = await getAgentdClientConfigByNodeId(nodeId);
    if (!config) return;
    const body: Record<string, unknown> = { exec_session_id: execSessionId };
    // Only include the fencing token when the acquire path produced one
    // (lock not acquired ⇒ no generation ⇒ omit the field, don't send
    // undefined/null).
    if (nodeGeneration != null) body.node_generation = nodeGeneration;
    await requestAgentd(
      config,
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/lock/release`,
      body,
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
  /** Fencing token captured at acquire time (from the acquire response,
   *  falling back to the workspace row). Null when no lock was acquired.
   *  Forwarded on release so agentd can reject stale-generation releases. */
  nodeGeneration: number | null;
  /** The session's workspace ID as resolved from the session row at acquire
   *  time — populated even when the lock itself was NOT acquired (busy, no
   *  preferred node, transport error). Consumers that need the workspace
   *  scope regardless of lock state (e.g. post-run memory extraction) must
   *  read THIS field, not workspaceId, so they never fall back to the
   *  global layer for a workspace-scoped session. Null only when the
   *  session genuinely has no workspace. */
  resolvedWorkspaceId: string | null;
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
    nodeGeneration: null,
    resolvedWorkspaceId: null,
  };
  if (!sessionId || !runId) return empty;
  // Hoisted so the catch path can still report the session's workspace when
  // the failure happened AFTER resolution (e.g. a transport error from
  // acquireWorkspaceLock). Null here means "never resolved" — only then may
  // the returned handle carry resolvedWorkspaceId: null.
  let wsId: string | null = null;
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
    wsId = sessionRow?.workspaceId ? String(sessionRow.workspaceId) : null;
    if (!wsId) return empty;
    // From here on the session's workspace IS resolved — carry it on every
    // returned handle (even the not-acquired ones) via resolvedWorkspaceId.
    const notAcquired: RunLockHandle = { ...empty, resolvedWorkspaceId: wsId };
    const [wsRow] = await db
      .select({
        preferredNodeId: workspaces.preferredNodeId,
        nodeGeneration: workspaces.nodeGeneration,
      })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .limit(1);
    const nodeId = wsRow?.preferredNodeId ?? null;
    if (!nodeId) return notAcquired;
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
      return notAcquired;
    }
    return {
      nodeId,
      workspaceId: wsId,
      execSessionId: runId,
      // Fencing token: prefer the daemon-echoed generation from the acquire
      // response (the value the lock was actually taken under), fall back to
      // the workspace row value we sent.
      nodeGeneration:
        result.state?.node_generation ?? wsRow?.nodeGeneration ?? null,
      resolvedWorkspaceId: wsId,
    };
  } catch (error) {
    logger.warn('acquireRunLockStep failed (non-fatal)', {
      sessionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...empty, resolvedWorkspaceId: wsId };
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
    nodeGeneration: handle.nodeGeneration,
  });
}
