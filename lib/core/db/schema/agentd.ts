import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './chat';

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: uuid('session_id'),
  userId: text('user_id'),
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
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentReviewLogs = pgTable('agent_review_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull(),
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
});

export const agentToolActivityLogs = pgTable(
  'agent_tool_activity_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id'),
    sessionId: uuid('session_id'),
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

export const workspaces = pgTable('workspaces', {
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
