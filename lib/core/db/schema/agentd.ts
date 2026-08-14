import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sessions } from './chat';

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: uuid('session_id'),
    userId: text('user_id'),
    /** Workspace this task belongs to. Backfilled for legacy rows. */
    workspaceId: uuid('workspace_id'),
    command: text('command').notNull(),
    sandboxType: text('sandbox_type').default('auto').notNull(),
    sandboxId: text('sandbox_id'),
    source: jsonb('source').$type<Record<string, unknown>>(),
    env: jsonb('env').$type<Record<string, string>>(),
    timeout: integer('timeout').default(300),
    status: text('status', {
      enum: [
        'pending',
        'reviewing',
        'running',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .default('pending')
      .notNull(),
    result: text('result'),
    /**
     * Canonical failure reason from the {@link FAILURE_REASON} taxonomy
     * (`lib/core/task/failure-reason.ts`). Replaces the historical pattern
     * of putting free-text into `result`. Persisted as plain text (not a
     * CHECK enum) so the taxonomy can grow without a migration per value;
     * callers validate via `ALL_FAILURE_REASONS.includes(value)` if needed.
     */
    failureReason: text('failure_reason'),
    /**
     * 1-based attempt number. The original attempt is 1; each auto-retry
     * spawns a child task whose attempt = parent.attempt + 1. See
     * `retry_of_task_id` for the lineage pointer.
     */
    attempt: integer('attempt').default(1).notNull(),
    /** Max attempts before the task gives up. Default 2 (one auto-retry). */
    maxAttempts: integer('max_attempts').default(2).notNull(),
    /** Parent task of this retry chain (NULL on the original attempt). */
    retryOfTaskId: uuid('retry_of_task_id'),
    /**
     * Distinct from `retry_of_task_id`: a manual "rerun" (regenerate)
     * lineage pointer. `retry_of_task_id` is system-driven retry against
     * transient failures; `rerun_of_task_id` is user-driven rerun, which
     * always starts a fresh session for rollback safety.
     */
    rerunOfTaskId: uuid('rerun_of_task_id'),
    /**
     * Node that currently owns execution of this task. NULL for tasks
     * that are pending review/assignment, OR for legacy rows created
     * before run-level leases were introduced. Set at claim time
     * (pending → reviewing/running) by a node, and renewed on every
     * heartbeat via renewTaskLeases(). Cleared on terminal status.
     *
     * The owner guard in updateTaskStatus uses this column: a status
     * mutation from a non-owner node is rejected, so a stale daemon
     * returning after a lease expiry cannot clobber the recovery another
     * node performed. Identity is trusted from the mTLS peer (the
     * /api/agentd/v1/* boundary is AGENTD_API_KEY + mTLS gated), never
     * from a body field — same rule as user_id on this boundary.
     */
    ownerNodeId: text('owner_node_id'),
    /**
     * UTC deadline by which the owner node must renew (via heartbeat) or
     * the task becomes eligible for orphan reclaim. NULL = legacy row or
     * pre-claim pending task. NOTE: reapOrphanedTasks()'s reclaim
     * predicate is `lease_expires_at <= cutoff`, which under SQL
     * three-valued logic is never true for NULL — NULL-lease rows are
     * NOT reclaimed by the reaper. Pre-claim pending tasks instead wait
     * for a node to claim them via updateTaskStatus (which matches
     * `owner_node_id IS NULL`). Renewed every heartbeat by
     * renewTaskLeases(nodeId) to now + TASK_LEASE_SECONDS.
     */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    failureReasonIdx: index('agent_tasks_failure_reason_idx').on(
      table.failureReason,
    ),
    retryOfTaskIdIdx: index('agent_tasks_retry_of_task_id_idx').on(
      table.retryOfTaskId,
    ),
    rerunOfTaskIdIdx: index('agent_tasks_rerun_of_task_id_idx').on(
      table.rerunOfTaskId,
    ),
    // Powers renewTaskLeases(nodeId) (hot path: every heartbeat filters by
    // owner_node_id) and reapOrphanedTasks() (cold path: scans expired
    // in-flight rows across all owners). Leading with owner_node_id lets the
    // hot renew path index-skip straight to this node's rows; reap still
    // works because the partial predicate + a lease_expires_at range scan
    // under it remains cheaper than a seqscan on a populated agent_tasks.
    // Partial (only pending/reviewing/running) because terminal rows are
    // never reclaimed and would bloat a full index.
    leaseExpiresAtIdx: index('agent_tasks_lease_expires_at_idx')
      .on(table.ownerNodeId, table.leaseExpiresAt)
      .where(sql`status IN ('pending', 'reviewing', 'running')`),
  }),
);

export const agentReviewLogs = pgTable(
  'agent_review_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    /** Workflow run id used to correlate this review with a Trace. */
    traceId: text('trace_id'),
    userId: text('user_id'),
    roles: text('roles').array(),
    command: text('command').notNull(),
    level: text('level', { enum: ['L0', 'L1', 'L2'] }).notNull(),
    score: integer('score'),
    decision: text('decision', {
      enum: [
        'allowed',
        'allowed_with_warning',
        'blocked',
        'pending_confirm',
        'pending_l2',
        'pending_l2_critical',
        'approved',
        'rejected',
        'expired',
      ],
    }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    traceCreatedIdx: index('agent_review_logs_trace_created_idx').on(
      table.traceId,
      table.createdAt,
    ),
  }),
);

export const agentToolActivityLogs = pgTable(
  'agent_tool_activity_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id'),
    sessionId: uuid('session_id'),
    /** Workflow run id used to correlate this activity with a Trace. */
    traceId: text('trace_id'),
    agentId: text('agent_id').notNull(),
    userId: text('user_id'),
    roles: text('roles').array(),
    source: jsonb('source').$type<Record<string, unknown>>(),
    sandboxId: text('sandbox_id'),
    model: text('model'),
    step: integer('step'),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name').notNull(),
    action: text('action', {
      enum: ['read', 'write', 'execute', 'search', 'network', 'other'],
    }).notNull(),
    target: text('target'),
    arguments: jsonb('arguments').$type<unknown>(),
    result: jsonb('result').$type<unknown>(),
    outputText: text('output_text'),
    success: boolean('success').default(false).notNull(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    taskIdx: index('agent_tool_activity_logs_task_idx').on(table.taskId),
    sessionIdx: index('agent_tool_activity_logs_session_idx').on(
      table.sessionId,
    ),
    traceCreatedIdx: index('agent_tool_activity_logs_trace_created_idx').on(
      table.traceId,
      table.createdAt,
    ),
    agentCreatedIdx: index('agent_tool_activity_logs_agent_created_idx').on(
      table.agentId,
      table.createdAt,
    ),
    toolCreatedIdx: index('agent_tool_activity_logs_tool_created_idx').on(
      table.toolName,
      table.createdAt,
    ),
  }),
);

export const agentL0Rules = pgTable('agent_l0_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: text('agent_id').default('global').notNull(),
  pattern: text('pattern').notNull(),
  type: text('type', { enum: ['command', 'path', 'network'] }).notNull(),
  action: text('action', { enum: ['block', 'warn'] }).notNull(),
  scope: text('scope', { enum: ['workspace', 'global'] })
    .default('global')
    .notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentSandboxes = pgTable('agent_sandboxes', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: text('agent_id').notNull(),
  type: text('type', { enum: ['docker', 'docker-strict', 'lxc'] }).notNull(),
  path: text('path'),
  status: text('status', { enum: ['creating', 'ready', 'destroyed'] })
    .default('creating')
    .notNull(),
  persistent: boolean('persistent').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentTaskOutputs = pgTable('agent_task_outputs', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: text('task_id').notNull(),
  sessionId: uuid('session_id'),
  output: text('output').notNull(),
  streamPosition: integer('stream_position').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentMemories = pgTable(
  'agent_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: text('agent_id').notNull(),
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'cascade',
    }),
    userId: text('user_id'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    source: text('source'),
    accessCount: integer('access_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    agentUserCreatedIdx: index('agent_memories_agent_user_created_idx').on(
      table.agentId,
      table.userId,
      table.createdAt,
    ),
    agentSessionCreatedIdx: index(
      'agent_memories_agent_session_created_idx',
    ).on(table.agentId, table.sessionId, table.createdAt),
  }),
);

export interface Decision {
  id?: string;
  timestamp: string;
  description: string;
  reason: string;
  alternatives: string[];
}

/**
 * Legacy "projectId ↔ sandbox" binding records from the async agentTask
 * path (path B: agentd-run AgentLoop). Renamed from `workspaces` to make
 * room for the new user-facing {@link workspaces} table. Semantics
 * unchanged — one row per async task's project binding.
 */
export const projectSandboxes = pgTable('project_sandboxes', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: text('project_id').notNull().unique(),
  agentId: text('agent_id').notNull(),
  name: text('name'),
  sandboxId: text('sandbox_id').notNull(),
  sandboxType: text('sandbox_type').notNull(),
  status: text('status', {
    enum: ['active', 'archived'],
  })
    .default('active')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * User-facing workspace. Owns a 1:1 long-lived LXC container and scopes
 * sessions, memories, and builtin prompts. Single-user (`owner_id`) for
 * now; the shape leaves room for a future `workspace_members` table.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    /** Node the long-lived LXC container is bound to (M1). Nullable until
     *  the first task triggers lazy creation. */
    preferredNodeId: text('preferred_node_id'),
    /** Monotonic fencing token (M1). Bumped on failover so a stale node
     *  can detect it no longer owns the container and self-destruct. */
    nodeGeneration: integer('node_generation').default(1).notNull(),
    /** Designates the owner's single "default" workspace — the one
     *  getOrCreateDefaultWorkspace returns and migrate-workspaces.ts
     *  backfills for every user. The partial unique index below enforces
     *  at most ONE default per owner, closing the TOCTOU race where two
     *  concurrent first-requests could each create a default. */
    isDefault: boolean('is_default').default(false).notNull(),
    /** 'private': only the owner (and admins per the role hierarchy) can
     *  see/use it. 'public': every user can enter it — run tasks, manage
     *  its sessions and their messages. The execution environment (LXC
     *  container, memory scope) is shared by everyone who enters. */
    visibility: text('visibility', {
      enum: ['private', 'public'],
    })
      .default('private')
      .notNull(),
    /**
     * PUBLIC workspaces only: when true, memories extracted in this
     * workspace go into a shared pool visible to every member (personal
     * per-user memories are untouched). Turning this off — or converting
     * the workspace back to private — deletes the shared pool.
     */
    sharedMemoryEnabled: boolean('shared_memory_enabled')
      .default(false)
      .notNull(),
    /**
     * Monotonic counter incremented each time a workspace is privatized
     * (public→private). The privatization soft-quarantines the shared pool
     * (rows flipped to dream_status='quarantined' with quarantine_meta
     * recording this epoch). On re-public, restoreQuarantinedMemories
     * resurrects rows whose restoredByRunId is null; "consumed" is
     * recorded per-row via quarantine_meta.restoredByRunId — this counter
     * is NOT bumped on restore, it only ever increments on privatization.
     * Used to disambiguate which quarantined rows belong to the current
     * private spell vs. historical ones. See
     * docs/design/soft-quarantine-memory-on-privatization.md §3.
     */
    quarantineEpoch: integer('quarantine_epoch').default(0).notNull(),
    status: text('status', {
      enum: ['active', 'archived'],
    })
      .default('active')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ownerIdx: index('workspaces_owner_idx').on(table.ownerId),
    // At most one default workspace per owner. Partial unique index so
    // non-default rows (the vast majority) are unconstrained.
    ownerDefaultUnique: uniqueIndex('workspaces_owner_default_uniq')
      .on(table.ownerId)
      .where(sql`is_default = true`),
  }),
);

export const taskSummaries = pgTable(
  'task_summaries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: uuid('session_id'),
    workspaceId: uuid('workspace_id'),
    status: text('status', {
      enum: ['active', 'paused', 'completed'],
    })
      .default('active')
      .notNull(),
    progress: text('progress'),
    decisions: jsonb('decisions').$type<Decision[]>(),
    pending: jsonb('pending').$type<string[]>(),
    knownIssues: jsonb('known_issues').$type<string[]>(),
    version: integer('version').default(1).notNull(),
    isCurrent: boolean('is_current').default(true).notNull(),
    lastUpdated: timestamp('last_updated', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    taskCurrentIdx: index('task_summaries_task_current_idx').on(
      table.taskId,
      table.isCurrent,
    ),
  }),
);

export const archivedTaskSummaries = pgTable('archived_task_summaries', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  agentId: text('agent_id').notNull(),
  sessionId: uuid('session_id'),
  workspaceId: uuid('workspace_id'),
  status: text('status', {
    enum: ['active', 'paused', 'completed'],
  }).notNull(),
  progress: text('progress'),
  decisions: jsonb('decisions').$type<Decision[]>(),
  pending: jsonb('pending').$type<string[]>(),
  knownIssues: jsonb('known_issues').$type<string[]>(),
  version: integer('version').notNull(),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentdNodes = pgTable('agentd_nodes', {
  nodeID: text('node_id').primaryKey(),
  ip: text('ip').notNull(),
  port: integer('port').notNull(),
  sandboxes: jsonb('sandboxes').$type<string[]>().notNull(),
  version: text('version').notNull(),
  status: text('status', { enum: ['online', 'offline'] })
    .default('online')
    .notNull(),
  cpuModel: text('cpu_model'),
  cpuUsage: integer('cpu_usage'),
  memAvail: integer('mem_avail'),
  diskAvail: integer('disk_avail'),
  activeTasks: integer('active_tasks').default(0),
  activeSandboxes: integer('active_sandboxes').default(0),
  /**
   * P3.3: aggregates rolled up from per-sandbox cgroup v2 samples
   * received in the heartbeat. -1 (or null when no sandboxes are
   * active) means "no cgroup data" — NodeSelector should fall back
   * to host-level metrics.
   *
   *   sandboxMemCurrentTotal = Σ memory.current across active sandboxes
   *   sandboxMemPeakTotal    = max(Σ memory.peak) — high-water mark
   *   sandboxCpuUsecTotal    = Σ cpu.stat usage_usec (cumulative counter)
   *
   * The CPU counter is monotonic; NodeSelector diffs it across two
   * heartbeats and divides by the elapsed time to get a percentage.
   */
  sandboxMemCurrentTotal: integer('sandbox_mem_current_total'),
  sandboxMemPeakTotal: integer('sandbox_mem_peak_total'),
  sandboxCpuUsecTotal: integer('sandbox_cpu_usec_total'),
  lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }),
  registeredAt: timestamp('registered_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
