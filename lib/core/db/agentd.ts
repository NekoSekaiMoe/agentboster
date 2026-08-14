import {
  and,
  desc,
  eq,
  isNull,
  like,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { sanitizeToolActivityPayload } from '@/lib/core/blob/sanitize';
import { findNodeByAddress } from '@/lib/extra/agent/node-liveness';
import { TASK_LEASE_SECONDS } from '@/lib/core/agent/task-lease-constants';
import { getUserById, hasAdminRole, hasOwnerRole } from '@/lib/core/db/users';
import { db } from './index';
import {
  agentdNodes,
  agentL0Rules,
  agentMemories,
  agentSandboxes,
  agentTaskOutputs,
  agentTasks,
  sessions,
  longTermMemories,
  sessionMemories,
  taskSummaries,
  users,
  workspaces,
  projectSandboxes,
} from './schema';
import { atomicWriteMode } from './atomic';
import { bumpSharedMemoryVersion } from '@/lib/memory/shared-version';
import type { Decision } from './schema';
import { ingestTraceSpan } from '@/lib/core/trace/dal';

type AgentdTask = typeof agentTasks.$inferSelect & {
  roles?: string[];
  source?: Record<string, unknown> | null;
};

const REVIEW_DECISIONS = [
  'allowed',
  'allowed_with_warning',
  'blocked',
  'pending_confirm',
  'pending_l2',
  'pending_l2_critical',
  'approved',
  'rejected',
  'expired',
] as const;
type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
const TOOL_ACTIVITY_ACTIONS = [
  'read',
  'write',
  'execute',
  'search',
  'network',
  'other',
] as const;
type ToolActivityAction = (typeof TOOL_ACTIVITY_ACTIONS)[number];

type ToolActivityLogInput = {
  traceId?: string;
  trace_id?: string;
  runId?: string;
  run_id?: string;
  taskId?: string;
  task_id?: string;
  sessionId?: string;
  session_id?: string;
  agentId?: string;
  agent_id?: string;
  userId?: string;
  user_id?: string;
  roles?: string[];
  source?: Record<string, unknown>;
  sandboxId?: string;
  sandbox_id?: string;
  model?: string;
  step?: number;
  toolCallId?: string;
  tool_call_id?: string;
  toolName?: string;
  tool_name?: string;
  action?: string;
  target?: string;
  arguments?: unknown;
  args?: unknown;
  result?: unknown;
  outputText?: string;
  output_text?: string;
  success?: boolean;
  error?: string;
  durationMs?: number;
  duration_ms?: number;
  startedAt?: string | Date;
  started_at?: string | Date;
  completedAt?: string | Date;
  completed_at?: string | Date;
  idempotencyKey?: string;
  idempotency_key?: string;
};

export type AgentdResourceScope = {
  taskId?: string | null;
  sessionId?: string | null;
};

type TaskAccessRecord = Omit<AgentdTask, 'roles' | 'sessionId' | 'source'> & {
  sessionId: string;
  roles: string[];
  source: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export async function deriveSessionIdentity(
  sessionId?: string | null,
): Promise<{
  userId: string | null;
  roles: string[];
  source: Record<string, unknown> | null;
}> {
  if (!sessionId) {
    return { userId: null, roles: [], source: null };
  }

  const [session] = await db
    .select({
      userId: sessions.userId,
      channel: sessions.channel,
      externalThreadId: sessions.externalThreadId,
      metadata: sessions.metadata,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session) {
    return { userId: null, roles: [], source: null };
  }

  const metadataSource = normalizeSource(session.metadata?.source);
  const fallbackSource =
    session.channel && session.externalThreadId && session.channel !== 'web'
      ? {
          type: 'im',
          adapter: session.channel,
          origin: session.externalThreadId,
          threadId: session.externalThreadId,
        }
      : null;
  const source = metadataSource ?? fallbackSource;

  if (!session.userId) {
    return { userId: null, roles: [], source };
  }

  const [user] = await db
    .select({ id: users.id, roles: users.roles })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  return {
    userId: user?.id ?? session.userId,
    roles: (user?.roles as string[] | undefined) ?? [],
    source,
  };
}

export async function deriveTaskIdentity(taskId: string): Promise<{
  userId: string | null;
  roles: string[];
  source: Record<string, unknown> | null;
}> {
  const [task] = await db
    .select({
      userId: agentTasks.userId,
      sessionId: agentTasks.sessionId,
      source: agentTasks.source,
    })
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId))
    .limit(1);

  if (!task) {
    return { userId: null, roles: [], source: null };
  }

  const sessionIdentity = await deriveSessionIdentity(task.sessionId);
  return {
    userId: task.sessionId ? sessionIdentity.userId : (task.userId ?? null),
    roles: sessionIdentity.roles,
    source: task.sessionId
      ? sessionIdentity.source
      : (normalizeSource(task.source) ?? null),
  };
}

function taskAccessError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function isSameSession(left?: string | null, right?: string | null) {
  return Boolean(left) && Boolean(right) && left === right;
}

async function requireTaskAccess(input: {
  taskId: string;
  sessionId?: string | null;
}): Promise<TaskAccessRecord> {
  const task = await getTask(input.taskId);
  if (!task) {
    throw taskAccessError(404, 'Task not found');
  }

  if (!task.sessionId) {
    throw taskAccessError(403, 'Task is not bound to a session');
  }

  if (
    input.sessionId !== undefined &&
    !isSameSession(task.sessionId, input.sessionId)
  ) {
    throw taskAccessError(403, 'Task/session mismatch');
  }

  return {
    ...task,
    sessionId: task.sessionId,
    roles: task.roles ?? [],
    source: task.source ?? null,
  };
}

export function getResourceErrorStatus(error: unknown) {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === 'number' ? status : 500;
}

export function getResourceErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Internal server error';
}

/**
 * Resolve the user identity that owns an agentd-scope resource.
 *
 * This is the single entry point every `/api/agentd/v1/*` route SHOULD use
 * to turn a request into a `{ userId, isAdmin }` access scope. It NEVER
 * trusts a client-supplied `user_id` field — identity is always derived
 * server-side from the task or session row the caller is operating on.
 *
 * Resolution order:
 *   1. If `taskId` is present, the task is loaded (and optionally checked
 *      against `sessionId` via {@link requireTaskAccess}); its owner
 *      becomes the resolved user. A task without an owner is a 403.
 *   2. Otherwise `sessionId` is required; the session row is loaded via
 *      {@link deriveSessionIdentity}; its owner becomes the resolved user.
 *      A session without an owner is a 404.
 *
 * Rationale: agentd routes are gated only by the shared `AGENTD_API_KEY`
 * (see `proxy.ts`). Without per-user identity at the boundary, any key
 * holder could impersonate any user by sending an arbitrary `user_id` in
 * the request body. Routing identity through the owned task/session row
 * closes that gap — the caller can only act within a scope the server
 * already attached to a specific user.
 */
export async function resolveAgentdResourceAccess(input: {
  taskId?: string | null;
  sessionId?: string | null;
}): Promise<{ userId: string; isAdmin: boolean }> {
  if (input.taskId) {
    const task = await requireTaskAccess({
      taskId: input.taskId,
      sessionId: input.sessionId,
    });
    if (!task.userId) {
      throw Object.assign(new Error('Task owner is unknown'), { status: 403 });
    }
    return {
      userId: task.userId,
      isAdmin: hasAdminRole(task.roles),
    };
  }

  if (!input.sessionId) {
    throw Object.assign(new Error('task_id or session_id is required'), {
      status: 400,
    });
  }

  const identity = await deriveSessionIdentity(input.sessionId);
  if (!identity.userId) {
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }

  return {
    userId: identity.userId,
    isAdmin: hasAdminRole(identity.roles),
  };
}

function normalizeDecision(value: string): ReviewDecision {
  const allowed = new Set<string>(REVIEW_DECISIONS);
  return (allowed.has(value) ? value : 'allowed') as ReviewDecision;
}

function normalizeScore(value: number | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return value > 0 && value <= 1 ? Math.round(value * 100) : Math.round(value);
}

function normalizeNullableText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value;
}

function normalizeDate(value: string | Date | undefined): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeToolAction(value: string | undefined): ToolActivityAction {
  const allowed = new Set<string>(TOOL_ACTIVITY_ACTIONS);
  return (value && allowed.has(value) ? value : 'other') as ToolActivityAction;
}

export function formatTaskForAgentd(task: AgentdTask) {
  return {
    id: task.id,
    agent_id: task.agentId,
    session_id: task.sessionId,
    user_id: task.userId ?? null,
    roles: task.roles ?? [],
    source: task.source ?? null,
    command: task.command,
    sandbox_type: task.sandboxType,
    sandbox_id: task.sandboxId,
    env: task.env,
    timeout: task.timeout,
    status: task.status,
    result: task.result,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

// === Tasks ===

export async function createTask(data: {
  id?: string;
  agentId: string;
  sessionId?: string;
  command: string;
  sandboxType?: string;
  sandboxId?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Node that will own execution of this task. When provided (the daemon
   *  createTask path carries node_id), the task is created with a live
   *  lease so the first heartbeat renews it. When omitted (a task queued
   *  pending review/assignment), owner/lease stay NULL until a node
   *  claims it via updateTaskStatus at the pending → running flip. */
  ownerNodeId?: string;
}) {
  if (!data.sessionId) {
    throw taskAccessError(400, 'session_id is required');
  }

  const identity = await deriveSessionIdentity(data.sessionId);
  if (!identity.userId) {
    throw taskAccessError(404, 'Session not found');
  }

  // Grant a lease at create time only when the caller is a known node.
  // A pending-review task (no owner yet) stays NULL-lease until claimed.
  const leaseExpiresAt = data.ownerNodeId
    ? new Date(Date.now() + TASK_LEASE_SECONDS * 1000)
    : null;

  const [task] = await db
    .insert(agentTasks)
    .values({
      agentId: data.agentId,
      sessionId: data.sessionId ?? null,
      userId: identity.userId,
      command: data.command,
      sandboxType: data.sandboxType ?? 'auto',
      sandboxId: data.sandboxId ?? null,
      source: identity.source,
      env: data.env ?? null,
      timeout: data.timeout ?? 300,
      status: 'pending',
      ownerNodeId: data.ownerNodeId ?? null,
      leaseExpiresAt,
    })
    .returning();
  return {
    ...task,
    roles: identity.roles,
    source: identity.source,
  };
}

export async function getTask(id: string) {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, id));
  if (!task) return null;
  const identity = await deriveTaskIdentity(task.id);
  return {
    ...task,
    userId: task.sessionId ? identity.userId : (identity.userId ?? task.userId),
    roles: identity.roles,
    source: task.sessionId
      ? identity.source
      : (identity.source ?? normalizeSource(task.source)),
  };
}

export async function updateTaskStatus(
  id: string,
  status: string,
  result?: string,
  options?: {
    /** Node asserting the update. When provided, the UPDATE is guarded by
     *  `owner_node_id = callerNodeId OR owner_node_id IS NULL`: the IS NULL
     *  branch is the CLAIM path — a task created without an owner (pending
     *  review) can be picked up by the first node that flips it, while a
     *  task that already has an owner can only be mutated by that owner,
     *  so a stale daemon returning after its lease expired (and the task
     *  was reclaimed) cannot clobber the recovery another node performed.
     *  Returns null when the caller does not own the row and the row is
     *  not claimable — the route maps that to 409. When omitted (legacy
     *  caller), the update is unconditional, preserving prior behavior.
     *
     *  FORWARD-COMPAT NOTE: the agentd Go client's UpdateTaskStatus does
     *  NOT currently send node_id, so this guard is a no-op on the
     *  daemon→Web path today (it activates once a caller passes
     *  ownerNodeId). The PRIMARY protection — reapOrphanedTasks flipping
     *  failed tasks of dead nodes — works independently of this guard;
     *  this guard only adds the narrower defense against a partitioned-
     *  then-recovered stale daemon clobbering a reclaimed task. Tracked
     *  separately. */
    ownerNodeId?: string;
  },
) {
  const updates: Record<string, unknown> = {
    status: status as (typeof agentTasks.status.enumValues)[number],
    result: result ?? null,
  };
  // Claim at the running flip: a pending/reviewing task transitioning
  //  to running is assigned to the caller node and granted a fresh lease.
  //  This is the path for tasks created without an owner (pending review)
  //  that a node picks up. Also refresh the lease on any in-flight →
  //  in-flight transition the owner makes, so status writes double as
  //  lease renewals (defense in depth on top of the heartbeat renewer).
  // NOTE: the set-object keys MUST be the drizzle TS property names
  //  (ownerNodeId / leaseExpiresAt), never the SQL column names —
  //  drizzle's buildUpdateSet only iterates the table's TS properties and
  //  SILENTLY DROPS unknown (snake_case) keys without an error.
  if (options?.ownerNodeId) {
    updates.ownerNodeId = options.ownerNodeId;
    if (status === 'running' || status === 'reviewing') {
      updates.leaseExpiresAt = new Date(Date.now() + TASK_LEASE_SECONDS * 1000);
    }
  }
  // Terminal statuses clear the lease so the partial index stops carrying
  //  the row and reapOrphanedTasks never touches it.
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    updates.leaseExpiresAt = null;
  }

  const conditions = [eq(agentTasks.id, id)];
  if (options?.ownerNodeId) {
    // Claim semantics: the caller may update a row it already owns OR an
    // unowned (owner_node_id IS NULL) row — the latter is how a pending-
    // review task gets claimed at the pending → reviewing/running flip.
    const ownership = or(
      eq(agentTasks.ownerNodeId, options.ownerNodeId),
      isNull(agentTasks.ownerNodeId),
    );
    if (ownership) {
      conditions.push(ownership);
    }
  }

  const [task] = await db
    .update(agentTasks)
    .set(updates)
    .where(and(...conditions))
    .returning();
  if (!task) return task;
  const identity = await deriveTaskIdentity(task.id);
  return {
    ...task,
    userId: task.sessionId ? identity.userId : (identity.userId ?? task.userId),
    roles: identity.roles,
    source: task.sessionId
      ? identity.source
      : (identity.source ?? normalizeSource(task.source)),
  };
}

export async function listTasks(
  agentId: string,
  limit = 50,
  options?: { sessionId?: string; userId?: string },
) {
  const conditions = [eq(agentTasks.agentId, agentId)];
  if (options?.sessionId) {
    conditions.push(eq(agentTasks.sessionId, options.sessionId));
  }
  if (options?.userId) {
    conditions.push(eq(agentTasks.userId, options.userId));
  }

  const tasks = await db
    .select()
    .from(agentTasks)
    .where(and(...conditions))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit);

  return Promise.all(
    tasks.map(async (task) => {
      const identity = await deriveTaskIdentity(task.id);
      return {
        ...task,
        userId: task.sessionId
          ? identity.userId
          : (identity.userId ?? task.userId),
        roles: identity.roles,
        source: task.sessionId
          ? identity.source
          : (identity.source ?? normalizeSource(task.source)),
      };
    }),
  );
}

// === Review Logs ===

export async function writeReviewLogs(
  logs: Array<{
    traceId?: string;
    trace_id?: string;
    runId?: string;
    run_id?: string;
    taskId?: string;
    task_id?: string;
    command: string;
    level: string;
    score?: number;
    decision: string;
    reason?: string;
    idempotencyKey?: string;
    idempotency_key?: string;
  }>,
) {
  const identityCache = new Map<
    string,
    Awaited<ReturnType<typeof deriveTaskIdentity>>
  >();

  async function identityFor(taskId: string) {
    const cached = identityCache.get(taskId);
    if (cached) return cached;
    const identity = await deriveTaskIdentity(taskId);
    identityCache.set(taskId, identity);
    return identity;
  }

  return Promise.all(
    logs.map(async (log) => {
      const taskId = log.taskId ?? log.task_id ?? '';
      const identity = await identityFor(taskId);
      const traceId =
        log.traceId ?? log.trace_id ?? log.runId ?? log.run_id ?? null;
      if (!traceId) {
        throw new Error(
          `Trace id is required for security review ${taskId || log.command}`,
        );
      }
      const task = taskId ? await getTask(taskId) : null;
      const decision = normalizeDecision(log.decision);
      const score = normalizeScore(log.score);
      return (
        await ingestTraceSpan({
          traceId,
          spanId: `review:${taskId || 'unknown'}:${log.level}:${log.command}`,
          parentSpanId: `model:${traceId}:0`,
          source: 'agentd',
          type: 'review',
          status: decision,
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 0,
          userId: identity.userId,
          sessionId: task?.sessionId ?? null,
          taskId: taskId || null,
          workspaceId: task?.workspaceId ?? null,
          agentId: task?.agentId ?? null,
          output: { decision, score, reason: log.reason ?? null },
          metadata: {
            level: log.level,
            decision,
            score,
            reason: log.reason ?? null,
            command: log.command,
          },
          idempotencyKey:
            log.idempotencyKey ??
            log.idempotency_key ??
            `review:${taskId}:${log.level}:${decision}:${log.command}`,
        })
      ).record;
    }),
  );
}

// === Tool Activity Logs ===

/**
 * Coerce a sanitized payload back into a nullable text value for text-typed
 * columns. sanitizeToolActivityPayload may replace an oversized string with
 * a `{__blob_ref__: ...}` marker object; text columns can't store that, so we
 * serialize the marker to JSON. Plain strings pass through.
 */
function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  // Marker object or any other shape — store as JSON text so the row still
  // carries the blob reference.
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export async function writeToolActivityLogs(logs: ToolActivityLogInput[]) {
  const taskIdentityCache = new Map<
    string,
    Awaited<ReturnType<typeof deriveTaskIdentity>>
  >();
  const sessionIdentityCache = new Map<
    string,
    Awaited<ReturnType<typeof deriveSessionIdentity>>
  >();

  async function identityFor(input: ToolActivityLogInput) {
    const taskId = input.taskId ?? input.task_id ?? '';
    if (taskId) {
      const cached = taskIdentityCache.get(taskId);
      if (cached) return cached;
      const identity = await deriveTaskIdentity(taskId);
      taskIdentityCache.set(taskId, identity);
      return identity;
    }

    const sessionId = input.sessionId ?? input.session_id ?? '';
    if (!sessionId) {
      return { userId: null, roles: [], source: null };
    }

    const cached = sessionIdentityCache.get(sessionId);
    if (cached) return cached;
    const identity = await deriveSessionIdentity(sessionId);
    sessionIdentityCache.set(sessionId, identity);
    return identity;
  }

  const values = await Promise.all(
    logs.map(async (log) => {
      const identity = await identityFor(log);
      const startedAt =
        normalizeDate(log.startedAt ?? log.started_at) ?? new Date();
      const completedAt = normalizeDate(log.completedAt ?? log.completed_at);

      // Large-payload sanitization (borrowed from AionCore's
      // sanitize_inline_image_result): offload any string leaf bigger than
      // 64 KiB (or 8 KiB for inline base64 images) to Blob storage, leaving a
      // __blob_ref__ marker in the DB row. Without this, a single screenshot
      // or `cat huge_file` would write multi-MB into the Postgres jsonb
      // column and bloat SSE broadcasts.
      const sessionIdForPrefix = log.sessionId ?? log.session_id ?? 'unknown';
      const taskIdForPrefix = log.taskId ?? log.task_id;
      const blobPrefix = `tool-activity/sess-${sessionIdForPrefix}${
        taskIdForPrefix ? `/task-${taskIdForPrefix}` : ''
      }`;
      const sanitizeOpts = {
        pathnamePrefix: blobPrefix,
      } satisfies Parameters<typeof sanitizeToolActivityPayload>[1];
      const [argumentsClean, resultClean, outputTextClean, errorClean] =
        await Promise.all([
          sanitizeToolActivityPayload(
            log.arguments ?? log.args ?? null,
            sanitizeOpts,
          ),
          sanitizeToolActivityPayload(log.result ?? null, sanitizeOpts),
          sanitizeToolActivityPayload(
            log.outputText ?? log.output_text ?? null,
            sanitizeOpts,
          ),
          sanitizeToolActivityPayload(log.error ?? null, sanitizeOpts),
        ]);

      return {
        taskId: normalizeNullableText(log.taskId ?? log.task_id),
        sessionId: normalizeNullableText(log.sessionId ?? log.session_id),
        traceId: normalizeNullableText(
          log.traceId ?? log.trace_id ?? log.runId ?? log.run_id,
        ),
        agentId: log.agentId ?? log.agent_id ?? 'default',
        userId: identity.userId,
        roles: identity.roles,
        source: identity.source,
        sandboxId: normalizeNullableText(log.sandboxId ?? log.sandbox_id),
        model: normalizeNullableText(log.model),
        step: typeof log.step === 'number' ? log.step : null,
        toolCallId: normalizeNullableText(log.toolCallId ?? log.tool_call_id),
        toolName: log.toolName ?? log.tool_name ?? 'unknown',
        action: normalizeToolAction(log.action),
        target: normalizeNullableText(log.target),
        arguments: argumentsClean.sanitized,
        result: resultClean.sanitized,
        outputText: asNullableText(outputTextClean.sanitized),
        success: log.success ?? false,
        error: asNullableText(errorClean.sanitized),
        durationMs:
          typeof (log.durationMs ?? log.duration_ms) === 'number'
            ? (log.durationMs ?? log.duration_ms)
            : null,
        startedAt,
        completedAt,
      };
    }),
  );

  return Promise.all(
    values.map(async (value, index) => {
      if (!value.traceId) {
        throw new Error(
          `Trace id is required for tool activity ${value.toolCallId ?? value.toolName}`,
        );
      }
      const task = value.taskId ? await getTask(value.taskId) : null;
      const original = logs[index];
      const startedAt = value.startedAt;
      const completedAt = value.completedAt;
      return (
        await ingestTraceSpan({
          traceId: value.traceId,
          spanId: `tool:${value.toolCallId ?? value.toolName}:${startedAt.getTime()}`,
          parentSpanId:
            value.step !== null && value.step !== undefined
              ? `model:${value.traceId}:${value.step}`
              : null,
          source: 'agentd',
          type: 'tool',
          status: value.success ? 'completed' : 'failed',
          startedAt,
          completedAt,
          durationMs: value.durationMs,
          userId: value.userId,
          sessionId: value.sessionId,
          taskId: value.taskId,
          workspaceId: task?.workspaceId,
          agentId: value.agentId,
          input: value.arguments,
          output: value.result,
          error: value.error ? { message: value.error } : null,
          metadata: {
            toolName: value.toolName,
            action: value.action,
            target: value.target,
            outputText: value.outputText,
            model: value.model,
            step: value.step,
            toolCallId: value.toolCallId,
            sandboxId: value.sandboxId,
            source: value.source,
          },
          idempotencyKey:
            original.idempotencyKey ??
            original.idempotency_key ??
            `tool:${value.taskId ?? value.sessionId ?? 'unknown'}:${value.toolCallId ?? value.toolName}:${startedAt.toISOString()}`,
        })
      ).record;
    }),
  );
}

// === L0 Rules ===

export async function getL0Rules(agentId: string) {
  return db
    .select()
    .from(agentL0Rules)
    .where(
      and(
        eq(agentL0Rules.enabled, true),
        or(
          eq(agentL0Rules.agentId, agentId),
          eq(agentL0Rules.agentId, 'global'),
        ),
      ),
    );
}

export async function listL0Rules() {
  return db.select().from(agentL0Rules).orderBy(desc(agentL0Rules.createdAt));
}

export async function createL0Rule(data: {
  agentId?: string;
  pattern: string;
  type: string;
  action: string;
  scope?: string;
  enabled?: boolean;
}) {
  const [rule] = await db
    .insert(agentL0Rules)
    .values({
      agentId: data.agentId ?? 'global',
      pattern: data.pattern,
      type: data.type as 'command' | 'path' | 'network',
      action: data.action as 'block' | 'warn',
      scope: (data.scope ?? 'global') as 'workspace' | 'global',
      enabled: data.enabled ?? true,
    })
    .returning();
  return rule;
}

export async function updateL0Rule(id: string, data: Record<string, unknown>) {
  const [rule] = await db
    .update(agentL0Rules)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(agentL0Rules.id, id))
    .returning();
  return rule;
}

export async function deleteL0Rule(id: string) {
  await db.delete(agentL0Rules).where(eq(agentL0Rules.id, id));
}

// === Sandboxes ===

export async function registerSandbox(data: {
  agentId: string;
  type: string;
  path?: string;
  persistent?: boolean;
}) {
  const [sb] = await db
    .insert(agentSandboxes)
    .values({
      agentId: data.agentId,
      type: data.type as 'docker' | 'docker-strict' | 'lxc',
      path: data.path ?? null,
      status: 'creating',
      persistent: data.persistent ?? false,
    })
    .returning();
  return sb;
}

export async function updateSandboxStatus(id: string, status: string) {
  const [sb] = await db
    .update(agentSandboxes)
    .set({ status: status as 'creating' | 'ready' | 'destroyed' })
    .where(eq(agentSandboxes.id, id))
    .returning();
  return sb;
}

// === Memories ===

async function resolveResourceScope(scope?: AgentdResourceScope): Promise<{
  sessionId: string;
  userId: string;
  roles: string[];
  source: Record<string, unknown> | null;
}> {
  if (scope?.taskId) {
    const task = await requireTaskAccess({
      taskId: scope.taskId,
      sessionId: scope.sessionId,
    });
    if (!task.userId) {
      throw taskAccessError(403, 'Task owner is unknown');
    }
    return {
      sessionId: task.sessionId,
      userId: task.userId,
      roles: task.roles,
      source: task.source,
    };
  }

  if (!scope?.sessionId) {
    throw taskAccessError(400, 'task_id or session_id is required');
  }

  const identity = await deriveSessionIdentity(scope.sessionId);
  if (!identity.userId) {
    throw taskAccessError(404, 'Session not found');
  }

  return {
    sessionId: scope.sessionId,
    userId: identity.userId,
    roles: identity.roles,
    source: identity.source,
  };
}

export async function getMemories(
  agentId: string,
  keywords: string[] = [],
  limit = 10,
  scope?: AgentdResourceScope,
) {
  const identity = await resolveResourceScope(scope);
  const conditions: SQL[] = [
    eq(agentMemories.agentId, agentId),
    eq(agentMemories.userId, identity.userId),
  ];

  if (keywords.length > 0) {
    conditions.push(
      ...keywords.map((keyword) => like(agentMemories.key, `%${keyword}%`)),
    );
  }

  return db
    .select()
    .from(agentMemories)
    .where(and(...conditions))
    .orderBy(desc(agentMemories.createdAt))
    .limit(limit);
}

export async function writeMemories(
  memories: Array<{
    agentId: string;
    key: string;
    value: string;
    source?: string;
  }>,
  scope?: AgentdResourceScope,
) {
  const identity = await resolveResourceScope(scope);
  return db
    .insert(agentMemories)
    .values(
      memories.map((m) => ({
        agentId: m.agentId,
        sessionId: identity.sessionId,
        userId: identity.userId,
        key: m.key,
        value: m.value,
        source: m.source ?? identity.sessionId,
      })),
    )
    .returning();
}

// === Task Outputs (Streaming) ===

export async function upsertAgentTaskOutput(data: {
  taskID: string;
  sessionID: string;
  output: string;
  streamPosition: number;
}) {
  const [record] = await db
    .insert(agentTaskOutputs)
    .values({
      taskId: data.taskID,
      sessionId: data.sessionID,
      output: data.output,
      streamPosition: data.streamPosition,
    })
    .returning();
  return record;
}

// === Task Summaries ===

export interface TaskSummaryRecord {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;
  status: 'active' | 'paused' | 'completed';
  progress: string | null;
  decisions: Decision[] | null;
  pending: string[] | null;
  knownIssues: string[] | null;
  version: number;
  lastUpdated: Date;
  createdAt: Date;
}

export async function getTaskSummary(
  taskId: string,
): Promise<TaskSummaryRecord | null> {
  const [row] = await db
    .select()
    .from(taskSummaries)
    .where(
      and(eq(taskSummaries.taskId, taskId), eq(taskSummaries.isCurrent, true)),
    );
  return row ?? null;
}

export async function upsertTaskSummary(data: {
  taskId: string;
  agentId: string;
  sessionId?: string;
  status?: 'active' | 'paused' | 'completed';
  progress?: string;
  decisions?: Decision[];
  pending?: string[];
  knownIssues?: string[];
}): Promise<TaskSummaryRecord> {
  // Check if a current version exists for this task
  const [existing] = await db
    .select()
    .from(taskSummaries)
    .where(
      and(
        eq(taskSummaries.taskId, data.taskId),
        eq(taskSummaries.isCurrent, true),
      ),
    );

  if (existing) {
    // Mark current version as not current
    await db
      .update(taskSummaries)
      .set({ isCurrent: false })
      .where(eq(taskSummaries.id, existing.id));

    // Insert new version
    const [record] = await db
      .insert(taskSummaries)
      .values({
        taskId: data.taskId,
        agentId: data.agentId,
        sessionId: data.sessionId ?? existing.sessionId ?? null,
        status: data.status ?? existing.status,
        progress: data.progress ?? existing.progress,
        decisions: data.decisions ?? existing.decisions,
        pending: data.pending ?? existing.pending,
        knownIssues: data.knownIssues ?? existing.knownIssues,
        version: existing.version + 1,
        isCurrent: true,
      })
      .returning();
    return record;
  }

  // No existing version — insert first version
  const [record] = await db
    .insert(taskSummaries)
    .values({
      taskId: data.taskId,
      agentId: data.agentId,
      sessionId: data.sessionId ?? null,
      status: data.status ?? 'active',
      progress: data.progress ?? null,
      decisions: data.decisions ?? null,
      pending: data.pending ?? null,
      knownIssues: data.knownIssues ?? null,
      version: 1,
      isCurrent: true,
    })
    .returning();
  return record;
}

export async function listActiveTaskSummaries(
  agentId: string,
  options?: { userId?: string },
): Promise<TaskSummaryRecord[]> {
  const conditions: SQL[] = [
    eq(taskSummaries.agentId, agentId),
    eq(taskSummaries.status, 'active'),
    eq(taskSummaries.isCurrent, true),
  ];
  if (options?.userId) {
    conditions.push(eq(sessions.userId, options.userId));
  }

  if (!options?.userId) {
    return db
      .select()
      .from(taskSummaries)
      .where(and(...conditions))
      .orderBy(desc(taskSummaries.lastUpdated));
  }

  return db
    .select({
      id: taskSummaries.id,
      taskId: taskSummaries.taskId,
      agentId: taskSummaries.agentId,
      sessionId: taskSummaries.sessionId,
      status: taskSummaries.status,
      progress: taskSummaries.progress,
      decisions: taskSummaries.decisions,
      pending: taskSummaries.pending,
      knownIssues: taskSummaries.knownIssues,
      version: taskSummaries.version,
      lastUpdated: taskSummaries.lastUpdated,
      createdAt: taskSummaries.createdAt,
    })
    .from(taskSummaries)
    .innerJoin(sessions, eq(taskSummaries.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(desc(taskSummaries.lastUpdated));
}

// === Project Sandboxes (legacy workspaces table, renamed) ============
// These are the path-B (async agentTask) "projectId ↔ sandbox" binding
// records. Renamed from `workspaces` to avoid collision with the new
// user-facing workspaces table. Semantics unchanged.

export interface ProjectSandboxRecord {
  id: string;
  projectId: string;
  agentId: string;
  name: string | null;
  sandboxId: string;
  sandboxType: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export async function createProjectSandbox(data: {
  projectId: string;
  agentId: string;
  name?: string;
  sandboxId: string;
  sandboxType: string;
}): Promise<ProjectSandboxRecord> {
  const [row] = await db
    .insert(projectSandboxes)
    .values({
      projectId: data.projectId,
      agentId: data.agentId,
      name: data.name ?? null,
      sandboxId: data.sandboxId,
      sandboxType: data.sandboxType,
      status: 'active',
    })
    .returning();
  return row;
}

export async function getProjectSandbox(
  id: string,
): Promise<ProjectSandboxRecord | null> {
  const [row] = await db
    .select()
    .from(projectSandboxes)
    .where(eq(projectSandboxes.id, id));
  return row ?? null;
}

export async function getProjectSandboxByProjectId(
  projectId: string,
): Promise<ProjectSandboxRecord | null> {
  const [row] = await db
    .select()
    .from(projectSandboxes)
    .where(eq(projectSandboxes.projectId, projectId));
  return row ?? null;
}

export async function listProjectSandboxes(
  agentId: string,
): Promise<ProjectSandboxRecord[]> {
  return db
    .select()
    .from(projectSandboxes)
    .where(eq(projectSandboxes.agentId, agentId))
    .orderBy(desc(projectSandboxes.updatedAt));
}

export async function archiveProjectSandbox(
  id: string,
): Promise<ProjectSandboxRecord | null> {
  const [row] = await db
    .update(projectSandboxes)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projectSandboxes.id, id))
    .returning();
  return row ?? null;
}

// === Workspaces (user-facing) ========================================

export interface WorkspaceRecord {
  id: string;
  ownerId: string;
  name: string;
  preferredNodeId: string | null;
  nodeGeneration: number;
  /** True for the owner's designated default workspace (created lazily by
   *  getOrCreateDefaultWorkspace). At most one per owner — enforced by the
   *  workspaces_owner_default_uniq partial unique index. */
  isDefault: boolean;
  /** 'private': owner (+ admins per role hierarchy) only. 'public': every
   *  user may enter — run tasks, manage sessions and their messages. */
  visibility: 'private' | 'public';
  /** PUBLIC workspaces only: extracted memories go into a shared pool
   *  visible to every member. Toggling off / going private deletes it. */
  sharedMemoryEnabled: boolean;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export async function createWorkspace(data: {
  ownerId: string;
  name: string;
}): Promise<WorkspaceRecord> {
  const [row] = await db
    .insert(workspaces)
    .values({
      ownerId: data.ownerId,
      name: data.name,
      status: 'active',
    })
    .returning();
  return row;
}

export async function getWorkspace(
  id: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return row ?? null;
}

export async function listWorkspacesByOwner(
  ownerId: string,
): Promise<WorkspaceRecord[]> {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, ownerId))
    .orderBy(desc(workspaces.updatedAt));
}

export interface VisibleWorkspaceRecord extends WorkspaceRecord {
  /** Owner's username, populated only for OTHER users' public workspaces
   *  (so the switcher can label shared entries). Undefined for own rows. */
  ownerName?: string;
}

/**
 * Every workspace the user may ENTER: their own (any status — archived
 * ones stay manageable from settings) plus other users' public ACTIVE
 * workspaces, labelled with the owner's username.
 */
/**
 * Upper bound on OTHER users' public workspaces surfaced by
 * listVisibleWorkspaces. The caller's own rows stay unbounded (their count
 * is naturally limited by per-user creation); the shared surface is not —
 * without a bound a pathological number of public workspaces would be
 * fetched, joined and shipped to every user's switcher on every call.
 */
const SHARED_VISIBLE_WORKSPACES_LIMIT = 100;

/** workspaces.owner_id is free-text (schema/agentd.ts) while users.id is
 *  uuid. Rows with a non-UUID owner (e.g. 'system') must be filtered out
 *  anywhere owner_id is cast to uuid or joined to users.id — otherwise PG
 *  22P02 (invalid input syntax for type uuid) aborts the whole query.
 *  TS-side mirror of OWNER_ID_UUID_FILTER for pre-query validation. */
const UUID_SHAPE_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** SQL-side mirror of UUID_SHAPE_REGEX, for WHERE clauses. */
const OWNER_ID_UUID_FILTER = sql`${workspaces.ownerId} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

export async function listVisibleWorkspaces(
  userId: string,
): Promise<VisibleWorkspaceRecord[]> {
  const own = await listWorkspacesByOwner(userId);
  const sharedRows = await db
    .select({ ws: workspaces, ownerName: users.username })
    .from(workspaces)
    // owner_id is free-text while users.id is uuid. Cast the WORKSPACES
    // side (not users.id::text): the query drives from workspaces (filtered
    // by visibility/status), and casting users.id would defeat the users
    // PK index on the per-row owner lookup — casting owner_id keeps that
    // lookup index-friendly.
    .innerJoin(users, eq(users.id, sql`${workspaces.ownerId}::uuid`))
    .where(
      and(
        ne(workspaces.ownerId, userId),
        eq(workspaces.visibility, 'public'),
        eq(workspaces.status, 'active'),
        // Skip rows whose owner_id is not UUID-shaped (e.g. 'system') —
        // the ::uuid join cast above would throw 22P02 on them.
        OWNER_ID_UUID_FILTER,
      ),
    )
    .orderBy(desc(workspaces.updatedAt))
    .limit(SHARED_VISIBLE_WORKSPACES_LIMIT);
  return [
    ...own,
    ...sharedRows.map((row) => ({ ...row.ws, ownerName: row.ownerName })),
  ];
}

/**
 * Manage rule (rename / set-default / migrate / set-visibility / archive):
 * the workspace owner always can; an admin-role actor can manage ordinary
 * users' workspaces but NEVER an owner/root's (mirrors the
 * PROTECTED_ROLE_SET hierarchy in canGrantRoles). Everyone else: no.
 *
 * Pure function — the caller supplies both role sets (it already has the
 * actor's from the session; the workspace owner's come from one users-row
 * lookup, see resolveWorkspaceAccess).
 */
export function canManageWorkspace(
  ws: Pick<WorkspaceRecord, 'ownerId'>,
  actor: { userId: string; roles: readonly string[] },
  workspaceOwnerRoles: readonly string[],
): boolean {
  if (actor.userId === ws.ownerId) return true;
  if (!hasAdminRole(actor.roles)) return false;
  return !hasOwnerRole(workspaceOwnerRoles);
}

/**
 * Access rule (enter the workspace, view its detail, run tasks, manage its
 * sessions and their messages): any manager, or anyone when the workspace
 * is public.
 */
export function canAccessWorkspace(
  ws: Pick<WorkspaceRecord, 'ownerId' | 'visibility'>,
  actor: { userId: string; roles: readonly string[] },
  workspaceOwnerRoles: readonly string[],
): boolean {
  if (ws.visibility === 'public') return true;
  return canManageWorkspace(ws, actor, workspaceOwnerRoles);
}

export interface WorkspaceAccess {
  ws: WorkspaceRecord;
  canAccess: boolean;
  canManage: boolean;
}

/**
 * Load a workspace and compute the actor's access level in two queries
 * (workspace row + owner's roles). Returns null when the workspace doesn't
 * exist — callers map that to 404 before access checks (403).
 */
export async function resolveWorkspaceAccess(
  id: string,
  actor: { userId: string; roles: readonly string[] },
): Promise<WorkspaceAccess | null> {
  const ws = await getWorkspace(id);
  if (!ws) return null;
  // owner_id is free-text; a non-UUID owner (e.g. 'system') would throw
  // 22P02 inside getUserById's eq(users.id, ...) uuid parse. Treat such
  // rows as ownerless — the same shape as a dangling owner reference
  // (owner lookup returned null).
  const workspaceOwnerRoles = UUID_SHAPE_REGEX.test(ws.ownerId)
    ? ((await getUserById(ws.ownerId))?.roles ?? [])
    : [];
  return {
    ws,
    canAccess: canAccessWorkspace(ws, actor, workspaceOwnerRoles),
    canManage: canManageWorkspace(ws, actor, workspaceOwnerRoles),
  };
}

/**
 * Toggle a workspace's public/private visibility. Manage-gated at the API
 * layer. Returns null when the workspace doesn't exist or is archived
 * (archived workspaces stay out of the shared surface).
 */
export async function setWorkspaceVisibility(
  id: string,
  visibility: 'private' | 'public',
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .update(workspaces)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .returning();
  return row ?? null;
}

/**
 * Toggle the shared-memory pool of a workspace. Meaningful only for PUBLIC
 * workspaces (the route enforces that); refuses archived rows. When the
 * toggle goes off the caller must also drop the shared pool
 * (deleteLongTermMemoriesByWorkspaceId with sharedOnly) — kept as separate
 * calls because that orchestration lives in the route layer.
 */
export async function setWorkspaceSharedMemory(
  id: string,
  enabled: boolean,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .update(workspaces)
    .set({ sharedMemoryEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .returning();
  return row ?? null;
}

/**
 * Atomically flip a workspace's visibility AND cascade every dependent
 * piece of state that must move with it. This is the DAL-level successor
 * to the old route-layer sequence (setWorkspaceVisibility → delete shared
 * memories → reset shared sessions → setWorkspaceSharedMemory(false)),
 * which performed four independent writes with no atomicity guarantee —
 * a mid-sequence failure left a half-migrated workspace (e.g. already
 * private but with lingering shared sessions that would silently
 * re-expose on the next re-public, the exact state `session-access.ts`'s
 * visibility guard defends against as a last resort).
 *
 * Two directions:
 *  - public  → private: soft-quarantine cascade. Shared-pool memory rows
 *    are flipped to dream_status='quarantined' (NOT deleted) so they can be
 *    restored on re-public via restoreQuarantinedMemories; the workspace's
 *    quarantine_epoch bumps to mark this isolation; shared sessions are
 *    reset to private AND their session_memories rows are stamped with
 *    quarantined_at. See docs/design/soft-quarantine-memory-on-privatization.md.
 *  - private → public: only the visibility column moves. Callers that
 *    also need the quarantined pool restored atomically with the flip
 *    (the workspaces route) use {@link publicizeWorkspaceCascade}
 *    instead — it folds the visibility UPDATE and the restore into one
 *    transaction/batch so a concurrent re-privatization cannot land
 *    between them. Restoration itself stays OUT of this cascade because
 *    it also fires a Dream merge that can take tens of seconds, and we
 *    do not want to block the plain visibility flip on it.
 *
 * Archived workspaces return null (the route maps that to 409). Because
 * neon-http's `db.batch` is NON-INTERACTIVE (it cannot read statement 1's
 * result before issuing statement 2), the archived check CANNOT live
 * inside the batch — it is performed as a separate read BEFORE the atomic
 * block. This costs one extra read but keeps neon/pg behavior identical
 * and lets the cascade skip entirely on archived rows.
 *
 * Atomic primitive selection follows the dual-driver split documented in
 * `lib/core/db/atomic.ts`: neon-http uses `db.batch([...])` (single HTTP
 * transaction, all-or-nothing), node-postgres uses `db.transaction(tx => …)`
 * (real interactive tx). The four batch elements are pre-built and have
 * NO inter-query dependency (the shared-memory toggle is written
 * unconditionally as `sharedMemoryEnabled=false` rather than conditional
 * on the pre-toggle row — semantically equivalent since going private is
 * exactly when the pool should be off), which is what the non-interactive
 * neon batch API requires.
 *
 * The shared-memory KV VERSION BUMP (`bumpSharedMemoryVersion`) is a KV
 * incr and therefore cannot participate in the DB transaction. It runs
 * AFTER the atomic block commits — order is "DB then KV" so a KV failure
 * never strands a half-applied DB state (KV is fail-open: a missed bump
 * only costs readers one cache rebuild, DB recall proceeds unaffected).
 *
 * Returns the final persisted workspace row, or null when the workspace
 * is archived (or missing). The route should use this return value as the
 * response `data` directly so `sharedMemoryEnabled` never reports a stale
 * `true` after going private. The number of shared-pool rows quarantined
 * (0 if the workspace was archived mid-flight or had no shared pool) is
 * surfaced separately to drive the KV version bump and the count returned
 * to the UI.
 */
export async function setWorkspaceVisibilityCascade(
  id: string,
  visibility: 'private' | 'public',
): Promise<WorkspaceRecord | null> {
  // Pre-flight: refuse archived (or missing) rows BEFORE entering the
  // atomic block. neon-http's batch is non-interactive, so the archived
  // short-circuit cannot live inside it; doing the read up front keeps
  // neon and pg behavior identical and avoids touching dependents on a
  // row that should be immutable.
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .limit(1);
  if (!existing) {
    return null;
  }

  // Single timestamp for every row this cascade touches — keeps the
  // public and private directions consistent and avoids two near-identical
  // `new Date()` calls drifting by microseconds.
  const now = new Date();

  // Private → public: only the visibility column moves.
  if (visibility === 'public') {
    const [row] = await db
      .update(workspaces)
      .set({ visibility: 'public', updatedAt: now })
      .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
      .returning();
    return row ?? null;
  }

  // Public → private: soft-quarantine cascade. Build every query up front
  // so the neon batch elements are independent (the batch API cannot read
  // between statements). The shared-memory toggle is written unconditionally
  // rather than conditional on the pre-toggle row — semantically identical
  // (going private is precisely when the pool should be off) and it removes
  // a read-after-write dependency that the non-interactive batch couldn't
  // satisfy anyway.
  //
  // The dependent writes (sessions reset, shared-pool quarantine, session
  // memory quarantine) are gated on the workspace STILL being active at
  // statement time via an inline `EXISTS` against `workspaces`. This
  // closes the TOCTOU window the pre-flight check opens: if a concurrent
  // archive flips the row to 'archived' between the pre-flight SELECT and
  // these writes, the EXISTS predicate is false and the writes become 0-row
  // no-ops on the now-immutable archived workspace's dependents. (The
  // workspaces-row UPDATEs already carry their own `status='active'` WHERE
  // guard.)
  const activeGuard = sql`EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.id = ${id} AND w.status = 'active')`;
  const updateVisibility = db
    .update(workspaces)
    .set({ visibility: 'private', updatedAt: now })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
  const resetSharedMemoryToggle = db
    .update(workspaces)
    .set({ sharedMemoryEnabled: false, updatedAt: now })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
  // Bump the quarantine epoch so this isolation snapshot is distinguishable
  // from historical ones (restored rows get quarantine_meta.restoredByRunId
  // and stay around for audit, but the epoch lets us reason about "the
  // current private spell").
  const bumpQuarantineEpoch = db
    .update(workspaces)
    .set({
      quarantineEpoch: sql`${workspaces.quarantineEpoch} + 1`,
      updatedAt: now,
    })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
  const resetSharedSessions = db
    .update(sessions)
    .set({ visibility: 'private', updatedAt: now })
    .where(
      and(
        eq(sessions.workspaceId, id),
        eq(sessions.visibility, 'shared'),
        activeGuard,
      ),
    );

  // The pre-epoch value is captured BEFORE the bump so quarantine_meta can
  // record "isolated by epoch N". Fetched as a separate read: the neon
  // batch is non-interactive, so we cannot read RETURNING from the epoch
  // bump inside the batch and feed it into the quarantine UPDATE.
  const [pre] = await db
    .select({ epoch: workspaces.quarantineEpoch })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  const isolatedEpoch = pre?.epoch ?? 0;

  // Shared-pool quarantine: flip active shared rows to 'quarantined' and
  // stamp quarantine_meta with the original dream_status so restoration
  // can return them to the correct state (an 'active' row isolated then
  // restored should not silently become a 'tentative' one). Non-active
  // rows (tentative/superseded/contradicted) are left untouched — they
  // are already invisible to recall, so quarantining them adds no
  // isolation and would only complicate the restore path. Only rows
  // belong to THIS workspace are touched.
  //
  // The SET carries the isolation metadata as a single jsonb build; we
  // read dream_status off the row via SQL (not Drizzle's per-row JS)
  // because this is a bulk UPDATE, not a per-row JS loop. Every
  // interpolated value is explicitly CAST (`::text` / `::int`) because
  // `jsonb_build_object` resolves its parameter types from the argument
  // list, and Postgres refuses to infer a type for a bare `$N` placeholder
  // — without the casts it fails with `could not determine data type of
  // parameter $N` (42P18) at parse time.
  const quarantineMetaSql = sql`jsonb_build_object(
    'workspaceId', ${id}::text,
    'isolatedAt', ${now.toISOString()}::text,
    'isolatedEpoch', ${isolatedEpoch}::int,
    'originalDreamStatus', dream_status
  )`;
  const quarantineSharedMemories = db
    .update(longTermMemories)
    .set({
      dreamStatus: 'quarantined',
      quarantineMeta: quarantineMetaSql,
      updatedAt: now,
    })
    .where(
      and(
        eq(longTermMemories.workspaceId, id),
        eq(longTermMemories.shared, true),
        eq(longTermMemories.dreamStatus, 'active'),
        activeGuard,
      ),
    );
  // Session-level summaries: stamp quarantined_at for any session_memories
  // belonging to a shared session of this workspace (one summary is kept
  // per session as is_current=true). We don't filter on is_current here —
  // historical (non-current) summaries for those sessions are quarantined
  // too, so a later `summary_version` bump on the now-private session does
  // not leave an unquarantined pre-privatization summary visible in the
  // shared view. Cleared by restoreQuarantinedMemories on re-public.
  //
  // ORDERING INVARIANT: this UPDATE filters its subquery on
  // sessions.visibility='shared', so it MUST execute BEFORE
  // resetSharedSessions flips those rows to 'private'. Inside a single
  // transaction/batch, later statements see earlier writes (READ
  // COMMITTED) — running the reset first would make this subquery match
  // 0 rows and the quarantine stamp would silently never be written.
  const quarantineSessionMemories = db
    .update(sessionMemories)
    .set({ quarantinedAt: now })
    .where(
      and(
        sql`session_id IN (SELECT id FROM ${sessions} WHERE workspace_id = ${id} AND visibility = 'shared')`,
        activeGuard,
      ),
    );

  // Did the shared-pool quarantine actually touch rows? Drives the KV
  // version bump below — if the workspace was archived mid-flight (or
  // there was simply no shared pool to quarantine), there is nothing for
  // readers to rebuild, so we skip the bump.
  let quarantinedSharedMemories = false;

  let finalRow: WorkspaceRecord | null = null;
  if (atomicWriteMode() === 'neon') {
    // neon-http: db.batch is the atomic primitive (single HTTP
    // transaction). The two workspaces UPDATEs are issued as separate
    // batch elements rather than fused so each one's effect is
    // independently observable; we re-read the final row after the
    // batch (the batch API cannot read between statements, so we cannot
    // use RETURNING from element 0 to gate element 1).
    // The shared-pool quarantine mirrors `quarantineSharedMemoriesByWorkspace`
    // but inlined as a standalone query object so it can be a batch element,
    // and so the cascade never has to reach back through the `db` mock
    // for its schema. The KV version bump is deferred to after commit,
    // and gated on the quarantine actually returning updated ids.
    // ORDERING: quarantineSessionMemories (index 3) MUST precede
    // resetSharedSessions (index 4) — its subquery matches sessions by
    // visibility='shared', which the reset flips to 'private'. See the
    // ORDERING INVARIANT comment on quarantineSessionMemories above.
    const results = await db.batch([
      updateVisibility,
      resetSharedMemoryToggle,
      bumpQuarantineEpoch,
      quarantineSessionMemories,
      resetSharedSessions,
      quarantineSharedMemories.returning({ id: longTermMemories.id }),
    ]);
    quarantinedSharedMemories = (results[5]?.length ?? 0) > 0;
    // Re-read the committed row so the response `data` reflects the
    // post-cascade state (sharedMemoryEnabled:false, visibility:private).
    const [row] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    finalRow = row ?? null;
  } else {
    // node-postgres: db.transaction is the atomic primitive. All writes
    // go through `tx`; a throw anywhere rolls the whole thing back.
    finalRow = await db.transaction(async (tx) => {
      await tx
        .update(workspaces)
        .set({ visibility: 'private', updatedAt: now })
        .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
      await tx
        .update(workspaces)
        .set({ sharedMemoryEnabled: false, updatedAt: now })
        .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
      // Bump quarantine_epoch — mirrors `bumpQuarantineEpoch` in the neon
      // batch branch above. The tx branch previously omitted this, so the
      // epoch stayed pinned at its initial value across repeated
      // private/public cycles even though quarantine_meta.isolatedEpoch
      // (built from the pre-read value) claimed each isolation had a
      // distinct epoch. Keeping the two branches in lockstep.
      await tx
        .update(workspaces)
        .set({
          quarantineEpoch: sql`${workspaces.quarantineEpoch} + 1`,
          updatedAt: now,
        })
        .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')));
      // Stamp session_memories for the shared sessions of this workspace.
      // MUST run BEFORE the sessions reset below: the WHERE subquery
      // matches sessions by visibility='shared', and inside this
      // transaction the reset's write is visible to later statements —
      // stamping after the reset would match 0 rows and the quarantine
      // would silently never be written (the exact read-your-writes
      // ordering bug this ordering fixes).
      await tx
        .update(sessionMemories)
        .set({ quarantinedAt: now })
        .where(
          and(
            sql`session_id IN (SELECT id FROM ${sessions} WHERE workspace_id = ${id} AND visibility = 'shared')`,
            activeGuard,
          ),
        );
      await tx
        .update(sessions)
        .set({ visibility: 'private', updatedAt: now })
        .where(
          and(
            eq(sessions.workspaceId, id),
            eq(sessions.visibility, 'shared'),
            activeGuard,
          ),
        );
      // Quarantine shared-pool memories WITHOUT a KV bump — the bump is
      // deferred to after the transaction commits (see below). Only active
      // shared rows are flipped; the WHERE mirrors the cascade's pre-built
      // `quarantineSharedMemories` query. Inlined against `tx` rather than
      // calling a helper so the cascade stays within the transaction's
      // `tx` handle. Reuses `quarantineMetaSql` (defined in the outer
      // scope) so the jsonb_build_object casts stay in one place.
      const quarantined = await tx
        .update(longTermMemories)
        .set({
          dreamStatus: 'quarantined',
          quarantineMeta: quarantineMetaSql,
          updatedAt: now,
        })
        .where(
          and(
            eq(longTermMemories.workspaceId, id),
            eq(longTermMemories.shared, true),
            eq(longTermMemories.dreamStatus, 'active'),
            activeGuard,
          ),
        )
        .returning({ id: longTermMemories.id });
      quarantinedSharedMemories = quarantined.length > 0;
      const [row] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
      return row ?? null;
    });
  }

  // KV version bump AFTER the DB block commits, and ONLY if the cascade
  // actually quarantined shared-pool rows. KV (Upstash HTTP / pg shim)
  // cannot join the DB transaction. Fail-open: a missed bump only costs
  // readers one shared-cache rebuild; DB recall is unaffected. Skipping
  // it when nothing was quarantined (no-op private→private, or a concurrent
  // archive that won the race and turned every write into a 0-row no-op)
  // avoids a spurious cache invalidation.
  if (quarantinedSharedMemories) {
    await bumpSharedMemoryVersion(id);
  }

  return finalRow;
}

/** Result of restoring a workspace's quarantined shared pool. */
export interface QuarantineRestoreResult {
  /** The committed workspace row (visibility now 'public'). Null if the
   *  workspace was archived or missing mid-restore. */
  workspace: WorkspaceRecord | null;
  /** Number of shared-pool long_term_memories rows flipped back from
   *  dream_status='quarantined' to their originalDreamStatus. Drives the
   *  UI toast ("Restored N memories") and gates the KV version bump +
   *  the Dream merge trigger. */
  restoredMemoryCount: number;
  /** Number of session_memories rows whose quarantined_at was cleared. */
  restoredSessionMemoryCount: number;
}

/** Build the restore UPDATE fragments shared by {@link
 *  restoreQuarantinedMemories} and {@link publicizeWorkspaceCascade}.
 *
 *  The shared-pool restore flips quarantined rows back to their
 *  originalDreamStatus (recorded at isolation time). The jsonb update
 *  merges restoredByRunId + restoredAt into the existing quarantine_meta
 *  via `||` so the isolation-side fields (workspaceId, isolatedAt,
 *  isolatedEpoch, originalDreamStatus) survive for audit. The
 *  dream_status is set by reading the same originalDreamStatus out of
 *  the jsonb — there is no separate column to read from.
 *
 *  The WHERE filters to unrestored quarantined rows of THIS workspace
 *  only (restoredByRunId IS NULL ⇒ never consumed). Rows consumed by an
 *  earlier re-public stay around but are skipped.
 *
 *  The session-memory WHERE clears quarantined_at for any
 *  session_memories of this workspace that were stamped during
 *  privatization. We do NOT filter on restoredByRunId here —
 *  session_memories carry no such marker; instead we clear any row whose
 *  quarantined_at is set, which is only ever written by the
 *  privatization cascade. If a workspace cycles
 *  private→public→private→public, the second privatization re-stamps
 *  quarantined_at (only for sessions still shared) and the second
 *  restore clears it again — there is no duplication risk because
 *  session_memories are keyed by (session_id, summary_version), not
 *  multiplied by the cycle count.
 *
 *  `guard` (publicize path only) is an extra statement-time predicate —
 *  e.g. "the workspace is STILL public+active" — appended to both
 *  WHEREs so a concurrent privatization that commits mid-transaction
 *  turns the restore into a 0-row no-op instead of resurrecting rows
 *  into a re-privatized workspace. */
function buildQuarantineRestoreParts(
  id: string,
  now: Date,
  runId: string | undefined,
  guard?: SQL,
) {
  const restoredByRunIdSql = runId ?? null;
  // COALESCE: rows quarantined before originalDreamStatus was recorded
  // (or with the key missing) fall back to 'active' instead of writing a
  // NULL into the NOT NULL dream_status column.
  const restoredDreamStatusSql = sql`COALESCE(quarantine_meta->>'originalDreamStatus', 'active')`;
  const restoreSharedMemoriesSet = {
    dreamStatus: restoredDreamStatusSql,
    quarantineMeta: sql`quarantine_meta || jsonb_build_object(
      'restoredByRunId', ${restoredByRunIdSql}::text,
      'restoredAt', ${now.toISOString()}::text
    )`,
    updatedAt: now,
  };
  const restoreSharedMemoriesWhere = and(
    eq(longTermMemories.workspaceId, id),
    eq(longTermMemories.dreamStatus, 'quarantined'),
    sql`(quarantine_meta->>'workspaceId') = ${id}`,
    sql`(quarantine_meta ? 'restoredByRunId') = false`,
    // Only restore rows whose (coalesced) original status is a known
    // non-quarantined lifecycle state; garbage values are left
    // quarantined rather than written into dream_status.
    sql`${restoredDreamStatusSql} IN ('active', 'tentative', 'superseded', 'contradicted')`,
    guard,
  );
  const restoreSessionMemoriesWhere = and(
    sql`session_id IN (SELECT id FROM ${sessions} WHERE workspace_id = ${id})`,
    sql`quarantined_at IS NOT NULL`,
    guard,
  );
  return {
    restoreSharedMemoriesSet,
    restoreSharedMemoriesWhere,
    restoreSessionMemoriesWhere,
  };
}

/**
 * Restore a workspace's soft-quarantined shared pool. The counterpart to
 * the public→private cascade in {@link setWorkspaceVisibilityCascade}:
 * when a workspace goes private→public, this flips every quarantined
 * long_term_memory row back to its `originalDreamStatus` (recorded in
 * quarantine_meta at isolation time) and clears session_memories.
 * quarantined_at.
 *
 * "Consumed" semantics are carried per-row by
 * quarantine_meta.restoredByRunId — NOT by quarantine_epoch. The epoch
 * only ever increments on privatization (public→private); this function
 * does not touch it.
 *
 * ONLY restores rows whose quarantine_meta.restoredByRunId is null — i.e.
 * rows isolated by a privatization that has NOT yet been consumed by a
 * previous restore. This preserves the "keep all history" decision: a row
 * consumed by an earlier re-public stays in the table for audit but is
 * never re-restored, so repeated private/public cycles never duplicate a
 * restored row into the active pool.
 *
 * Like the cascade, this is DB-only. The Dream merge that deduplicates /
 * consolidates the restored rows against the current pool is a separate,
 * slower step and is NOT folded in here — the route triggers it after
 * this returns (see docs/design/soft-quarantine-memory-on-privatization.md
 * §2.4). The KV shared-memory version bump runs AFTER the DB block
 * commits, only when rows were actually restored.
 *
 * Returns counts the caller surfaces to the UI and uses to gate the Dream
 * trigger. Archived / missing workspace → workspace:null with zero counts
 * (route maps to 409).
 */
export async function restoreQuarantinedMemories(
  id: string,
  runId?: string,
): Promise<QuarantineRestoreResult> {
  // Pre-flight: refuse archived (or missing) rows BEFORE entering the
  // atomic block, mirroring the cascade's contract. An archived workspace
  // is immutable — its quarantined rows stay quarantined forever.
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .limit(1);
  if (!existing) {
    return {
      workspace: null,
      restoredMemoryCount: 0,
      restoredSessionMemoryCount: 0,
    };
  }

  const now = new Date();
  const {
    restoreSharedMemoriesSet,
    restoreSharedMemoriesWhere,
    restoreSessionMemoriesWhere,
  } = buildQuarantineRestoreParts(id, now, runId);

  let restoredMemoryCount = 0;
  let restoredSessionMemoryCount = 0;
  let workspace: WorkspaceRecord | null = null;

  if (atomicWriteMode() === 'neon') {
    // neon-http: db.batch is the atomic primitive (single HTTP
    // transaction). RETURNING drives the counts + KV bump gate.
    const results = await db.batch([
      db
        .update(longTermMemories)
        .set(restoreSharedMemoriesSet)
        .where(restoreSharedMemoriesWhere)
        .returning({ id: longTermMemories.id }),
      db
        .update(sessionMemories)
        .set({ quarantinedAt: null })
        .where(restoreSessionMemoriesWhere)
        .returning({ id: sessionMemories.id }),
    ]);
    restoredMemoryCount = results[0]?.length ?? 0;
    restoredSessionMemoryCount = results[1]?.length ?? 0;
    const [row] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    workspace = row ?? null;
  } else {
    // node-postgres: db.transaction is the atomic primitive.
    workspace = await db.transaction(async (tx) => {
      const memRows = await tx
        .update(longTermMemories)
        .set(restoreSharedMemoriesSet)
        .where(restoreSharedMemoriesWhere)
        .returning({ id: longTermMemories.id });
      restoredMemoryCount = memRows.length;
      const sessRows = await tx
        .update(sessionMemories)
        .set({ quarantinedAt: null })
        .where(restoreSessionMemoriesWhere)
        .returning({ id: sessionMemories.id });
      restoredSessionMemoryCount = sessRows.length;
      const [row] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
      return row ?? null;
    });
  }

  // KV version bump AFTER the DB block commits, and ONLY if rows were
  // actually restored — same fail-open discipline as the cascade. A
  // missed bump costs readers one shared-cache rebuild; recall is
  // unaffected. Skipping the bump when nothing was restored (no-op
  // public→public, or a concurrent archive that won the race) avoids a
  // spurious cache invalidation.
  if (restoredMemoryCount > 0) {
    await bumpSharedMemoryVersion(id);
  }

  return {
    workspace,
    restoredMemoryCount,
    restoredSessionMemoryCount,
  };
}

/**
 * Atomic private→public path: flip workspaces.visibility to 'public' AND
 * restore the soft-quarantined shared pool in ONE transaction/batch.
 * This supersedes the route-layer sequence `setWorkspaceVisibilityCascade
 * (id,'public')` followed by `restoreQuarantinedMemories(id)`, which
 * committed the visibility flip and the restore in two separate
 * transactions — a concurrent public→private cascade could land in the
 * gap, and the restore (which did not check visibility) would then
 * resurrect quarantined rows into a now-PRIVATE workspace, re-exposing
 * them to recall (recall filters on `shared`, not on workspace
 * visibility).
 *
 * Atomicity here is two-layered:
 *  1. The visibility UPDATE and both restore UPDATEs share one DB
 *     transaction (pg) / HTTP batch (neon), so they commit or roll back
 *     together.
 *  2. Each restore UPDATE carries a statement-time `publicGuard` —
 *     `EXISTS (workspaces WHERE id AND status='active' AND
 *     visibility='public')` — re-evaluated when the statement runs.
 *     Under READ COMMITTED a concurrent privatization committed between
 *     our visibility flip and the restore statements IS visible, and the
 *     guard turns the restore into a 0-row no-op in that case.
 *
 * The Dream merge that consolidates restored rows is still NOT folded in
 * (it can take tens of seconds); the route triggers it via
 * `after()` after this returns. The KV shared-memory version bump runs
 * AFTER the DB block commits, only when rows were actually restored.
 *
 * Returns the committed workspace row plus restore counts. Archived /
 * missing workspace (or one archived mid-flight) → workspace:null with
 * zero counts (route maps to 409). The private→public Dream trigger and
 * count semantics mirror {@link restoreQuarantinedMemories}; the private
 * direction is unchanged and still lives in
 * {@link setWorkspaceVisibilityCascade}.
 */
export async function publicizeWorkspaceCascade(
  id: string,
  runId?: string,
): Promise<QuarantineRestoreResult> {
  // Pre-flight: refuse archived (or missing) rows BEFORE entering the
  // atomic block, mirroring the cascade's contract.
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .limit(1);
  if (!existing) {
    return {
      workspace: null,
      restoredMemoryCount: 0,
      restoredSessionMemoryCount: 0,
    };
  }

  const now = new Date();
  // Statement-time guard on the restore writes: the workspace must STILL
  // be public+active when each restore UPDATE executes. Closes the race
  // where a concurrent privatization cascade commits between our
  // visibility flip and the restore (READ COMMITTED makes that write
  // visible to later statements in this transaction) — without this the
  // restore would resurrect rows into a re-privatized workspace.
  const publicGuard = sql`EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.id = ${id} AND w.status = 'active' AND w.visibility = 'public')`;
  const {
    restoreSharedMemoriesSet,
    restoreSharedMemoriesWhere,
    restoreSessionMemoriesWhere,
  } = buildQuarantineRestoreParts(id, now, runId, publicGuard);
  const flipVisibilitySet = {
    visibility: 'public' as const,
    updatedAt: now,
  };
  const flipVisibilityWhere = and(
    eq(workspaces.id, id),
    eq(workspaces.status, 'active'),
  );

  let workspace: WorkspaceRecord | null = null;
  let restoredMemoryCount = 0;
  let restoredSessionMemoryCount = 0;

  if (atomicWriteMode() === 'neon') {
    // neon-http: single HTTP transaction. Element order matters: the
    // visibility flip (0) precedes the restore writes (1, 2) so their
    // publicGuard passes for the normal case.
    const results = await db.batch([
      db
        .update(workspaces)
        .set(flipVisibilitySet)
        .where(flipVisibilityWhere)
        .returning(),
      db
        .update(longTermMemories)
        .set(restoreSharedMemoriesSet)
        .where(restoreSharedMemoriesWhere)
        .returning({ id: longTermMemories.id }),
      db
        .update(sessionMemories)
        .set({ quarantinedAt: null })
        .where(restoreSessionMemoriesWhere)
        .returning({ id: sessionMemories.id }),
    ]);
    workspace = (results[0]?.[0] as WorkspaceRecord | undefined) ?? null;
    restoredMemoryCount = results[1]?.length ?? 0;
    restoredSessionMemoryCount = results[2]?.length ?? 0;
  } else {
    // node-postgres: db.transaction is the atomic primitive.
    workspace = await db.transaction(async (tx) => {
      const flipped = await tx
        .update(workspaces)
        .set(flipVisibilitySet)
        .where(flipVisibilityWhere)
        .returning();
      const row = flipped[0] ?? null;
      if (!row) {
        // Archived mid-flight — the publicGuard also makes the restore
        // writes 0-row no-ops, so skip straight to the abort.
        return null;
      }
      const memRows = await tx
        .update(longTermMemories)
        .set(restoreSharedMemoriesSet)
        .where(restoreSharedMemoriesWhere)
        .returning({ id: longTermMemories.id });
      restoredMemoryCount = memRows.length;
      const sessRows = await tx
        .update(sessionMemories)
        .set({ quarantinedAt: null })
        .where(restoreSessionMemoriesWhere)
        .returning({ id: sessionMemories.id });
      restoredSessionMemoryCount = sessRows.length;
      return row;
    });
  }

  // KV version bump AFTER the DB block commits, and ONLY if rows were
  // actually restored — same fail-open discipline as the cascade.
  if (restoredMemoryCount > 0) {
    await bumpSharedMemoryVersion(id);
  }

  return {
    workspace,
    restoredMemoryCount,
    restoredSessionMemoryCount,
  };
}

/**
 * Delete the workspace ROW itself. The caller (route layer) must first
 * clean up dependents — sessions (which cascade messages/session_memories),
 * long-term memories, builtin-memory overrides — because workspace_id
 * columns are deliberately soft-FK'd (rows must survive archival, so no
 * ON DELETE CASCADE exists). Removing the row also frees the per-owner
 * default slot; the next session lazily re-creates a default via
 * getOrCreateDefaultWorkspace.
 */
export async function deleteWorkspaceRow(
  id: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .delete(workspaces)
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}

export async function getOrCreateDefaultWorkspace(
  ownerId: string,
): Promise<WorkspaceRecord> {
  // Atomic per-owner default-workspace upsert. The partial unique index
  // workspaces_owner_default_uniq (owner_id WHERE is_default) is the
  // conflict target: two concurrent first-requests can no longer each
  // insert a default — the second hits the constraint and the DO UPDATE
  // arm returns the existing row. Works across both the neon-http and
  // node-postgres drivers (no advisory-lock / same-connection assumption).
  const [row] = await db
    .insert(workspaces)
    .values({
      ownerId,
      name: '默认工作区',
      isDefault: true,
    })
    .onConflictDoUpdate({
      target: [workspaces.ownerId],
      targetWhere: sql`is_default = true`,
      set: { updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function archiveWorkspace(
  id: string,
): Promise<WorkspaceRecord | null> {
  // Archiving must also drop the default flag: is_default is gated by the
  // partial unique index workspaces_owner_default_uniq (owner_id WHERE
  // is_default), and getOrCreateDefaultWorkspace's upsert returns the
  // existing default row WITHOUT filtering on status. If the flag survived
  // archival, the next getOrCreateDefaultWorkspace call would keep
  // returning this archived row instead of creating a fresh active default.
  const [row] = await db
    .update(workspaces)
    .set({ status: 'archived', isDefault: false, updatedAt: new Date() })
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}

/**
 * Rename a workspace. Returns null when the workspace doesn't exist.
 * Throws on an empty (post-trim) name — callers must not silently fall
 * back to the old name.
 */
export async function renameWorkspace(
  id: string,
  name: string,
): Promise<WorkspaceRecord | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Workspace name must not be empty');
  }
  const [row] = await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}

/** True when a Postgres unique-constraint violation names the per-owner
 *  default-workspace index. pg exposes `.code = '23505'`; neon-http wraps
 *  the server message, so match on the index name too. drizzle-orm
 *  additionally wraps driver errors in a DrizzleQueryError ("Failed query:
 *  ...") whose own code/message hide the PG error — walk the `.cause`
 *  chain so the wrapped violation is still recognised. */
function isDefaultUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== 'object') return false;
    const code = (current as { code?: unknown }).code;
    const message =
      current instanceof Error ? current.message : String(current);
    if (code === '23505' || message.includes('workspaces_owner_default_uniq')) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Designate `id` as the owner's single default workspace. Returns the
 * updated row, or null when the target doesn't exist, belongs to another
 * owner, or is archived.
 *
 * Implementation note — why NOT db.transaction(): the Vercel driver is
 * drizzle-orm/neon-http, whose session throws "No transactions support in
 * neon-http driver", and node-postgres (self-hosted) has no db.batch().
 * The portable atomic-enough shape is a clear-then-set PAIR, ordered so the
 * partial unique index workspaces_owner_default_uniq never sees two live
 * defaults: clearing first can only ever produce a transient ZERO-default
 * state, never a double-default one.
 *
 * The residual race: between the two statements a concurrent
 * getOrCreateDefaultWorkspace for the same owner observes "no default" and
 * inserts a fresh one; the second UPDATE then trips the unique index. We
 * retry the pair once (the freshly inserted default gets cleared and the
 * intended row wins); a second conflict propagates to the caller.
 */
export async function setDefaultWorkspace(
  ownerId: string,
  id: string,
): Promise<WorkspaceRecord | null> {
  const target = await getWorkspace(id);
  if (!target || target.ownerId !== ownerId || target.status !== 'active') {
    return null;
  }
  if (target.isDefault) return target;

  // Snapshot the owner's current default BEFORE the clear-then-set pair.
  // Targeted lookup (hits the workspaces_owner_default_uniq partial
  // index) rather than a full listWorkspacesByOwner scan + in-memory find.
  // If the SET (second UPDATE) fails with a NON-unique error, the CLEAR
  // has already committed — without this snapshot the owner would be left
  // with NO default at all, so the catch branch below best-effort restores
  // this row before rethrowing.
  const [previousDefaultRow] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, ownerId), eq(workspaces.isDefault, true)))
    .limit(1);
  const previousDefault = previousDefaultRow ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db
        .update(workspaces)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(eq(workspaces.ownerId, ownerId), eq(workspaces.isDefault, true)),
        );
      const [row] = await db
        .update(workspaces)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(workspaces.id, id), eq(workspaces.ownerId, ownerId)))
        .returning();
      return row ?? null;
    } catch (error) {
      if (isDefaultUniqueViolation(error)) {
        // Concurrent getOrCreateDefaultWorkspace won the race — retry the
        // pair once (see the doc comment above); a second conflict
        // propagates unchanged.
        if (attempt === 1) throw error;
        continue;
      }
      // Non-unique failure: the CLEAR may already have committed. Restore
      // the snapshot default (best-effort — never mask the original error),
      // then rethrow the ORIGINAL error.
      if (previousDefault) {
        try {
          await db
            .update(workspaces)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(
              and(
                eq(workspaces.id, previousDefault.id),
                eq(workspaces.ownerId, ownerId),
              ),
            );
        } catch {
          // Best-effort rollback — swallow so the original error wins.
        }
      }
      throw error;
    }
  }
  return null;
}

/**
 * Move a workspace's long-lived container binding to a different agentd
 * node (manual failover). Always bumps node_generation: the generation is
 * the fencing token a stale agentd compares against on its next lock
 * acquire, so ANY migration — including clearing the binding — must
 * invalidate the old container or two nodes could both believe they hold
 * it (split-brain). Pass no newNodeId to unbind; the next task then lazily
 * re-creates the container on a healthy node (same end state as the
 * automatic failover path in lib/extra/agent/workspace-failover.ts).
 *
 * Returns null when the workspace doesn't exist or is archived.
 */
export async function migrateWorkspaceNode(
  id: string,
  newNodeId?: string | null,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .update(workspaces)
    .set({
      preferredNodeId: newNodeId ?? null,
      nodeGeneration: sql`${workspaces.nodeGeneration} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(workspaces.id, id), eq(workspaces.status, 'active')))
    .returning();
  return row ?? null;
}

// === Agentd Nodes (Repository migration, AionCore §2) =====================

/**
 * Upsert an agentd node registration. Called by POST /api/agentd/v1/nodes/
 * register. If a row with the given node_id exists, refresh its ip/port/
 * sandboxes/version/heartbeat; otherwise insert. The (ip, port) reclaim
 * path is handled separately by `reclaimNodeAddress` so this function
 * stays focused on the by-node_id path.
 */
export async function upsertAgentdNode(input: {
  nodeID: string;
  ip: string;
  port: number;
  sandboxes: string[];
  version: string;
}) {
  const existing = await db
    .select({ nodeID: agentdNodes.nodeID })
    .from(agentdNodes)
    .where(eq(agentdNodes.nodeID, input.nodeID))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(agentdNodes)
      .set({
        ip: input.ip,
        port: input.port,
        sandboxes: input.sandboxes,
        version: input.version,
        status: 'online',
        lastHeartbeat: new Date(),
      })
      .where(eq(agentdNodes.nodeID, input.nodeID));
    return { inserted: false };
  }
  await db.insert(agentdNodes).values({
    nodeID: input.nodeID,
    ip: input.ip,
    port: input.port,
    sandboxes: input.sandboxes,
    version: input.version,
    status: 'online',
    lastHeartbeat: new Date(),
  });
  return { inserted: true };
}

/**
 * Reclaim a stale node row by (ip, port) when the daemon restarts with a
 * fresh node_id (host reboot wiped the persisted file). Updates the row's
 * node_id to the new value so subsequent heartbeats land on it. Returns
 * the reclaimed node_id if a row was found, else null.
 */
export async function reclaimNodeAddress(input: {
  ip: string;
  port: number;
  newNodeID: string;
}): Promise<string | null> {
  const byAddress = await findNodeByAddress(input.ip, input.port);
  if (!byAddress) return null;
  await db
    .update(agentdNodes)
    .set({ nodeID: input.newNodeID })
    .where(eq(agentdNodes.nodeID, byAddress.nodeID));
  return byAddress.nodeID;
}
