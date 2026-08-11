import { and, desc, eq, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { sanitizeToolActivityPayload } from '@/lib/core/blob/sanitize';
import { findNodeByAddress } from '@/lib/extra/agent/node-liveness';
import { getUserById, hasAdminRole, hasOwnerRole } from '@/lib/core/db/users';
import { db } from './index';
import {
  agentdNodes,
  agentL0Rules,
  agentMemories,
  agentReviewLogs,
  agentSandboxes,
  agentTaskOutputs,
  agentTasks,
  agentToolActivityLogs,
  sessions,
  taskSummaries,
  users,
  workspaces,
  projectSandboxes,
} from './schema';
import type { Decision } from './schema';

type AgentdTask = typeof agentTasks.$inferSelect & {
  roles?: string[];
  source?: Record<string, unknown> | null;
};

type ReviewDecision = (typeof agentReviewLogs.decision.enumValues)[number];
type ToolActivityAction =
  (typeof agentToolActivityLogs.action.enumValues)[number];

type ToolActivityLogInput = {
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

export async function requireTaskAccess(input: {
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
  const allowed = new Set<string>(agentReviewLogs.decision.enumValues);
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
  const allowed = new Set<string>(agentToolActivityLogs.action.enumValues);
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
}) {
  if (!data.sessionId) {
    throw taskAccessError(400, 'session_id is required');
  }

  const identity = await deriveSessionIdentity(data.sessionId);
  if (!identity.userId) {
    throw taskAccessError(404, 'Session not found');
  }

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
) {
  const [task] = await db
    .update(agentTasks)
    .set({
      status: status as (typeof agentTasks.status.enumValues)[number],
      result: result ?? null,
    })
    .where(eq(agentTasks.id, id))
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
    taskId?: string;
    task_id?: string;
    command: string;
    level: string;
    score?: number;
    decision: string;
    reason?: string;
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

  const values = await Promise.all(
    logs.map(async (log) => {
      const taskId = log.taskId ?? log.task_id ?? '';
      const identity = await identityFor(taskId);
      return {
        taskId,
        userId: identity.userId,
        roles: identity.roles,
        command: log.command,
        level: log.level as 'L0' | 'L1' | 'L2',
        score: normalizeScore(log.score),
        decision: normalizeDecision(log.decision),
        reason: log.reason ?? null,
      };
    }),
  );

  return db.insert(agentReviewLogs).values(values).returning();
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

  return db.insert(agentToolActivityLogs).values(values).returning();
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

export async function deleteMemory(id: string, scope?: AgentdResourceScope) {
  const identity = await resolveResourceScope(scope);
  await db
    .delete(agentMemories)
    .where(
      and(eq(agentMemories.id, id), eq(agentMemories.userId, identity.userId)),
    );
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
