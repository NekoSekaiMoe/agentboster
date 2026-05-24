import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: text('agent_id').notNull(),
  sessionId: uuid('session_id'),
  command: text('command').notNull(),
  sandboxType: text('sandbox_type').default('auto').notNull(),
  sandboxId: text('sandbox_id'),
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
  command: text('command').notNull(),
  level: text('level', { enum: ['L0', 'L1', 'L2'] }).notNull(),
  score: integer('score'),
  decision: text('decision', {
    enum: ['allowed', 'blocked', 'pending_confirm'],
  }).notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
  type: text('type', { enum: ['tmpfs', 'chroot', 'docker'] }).notNull(),
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

export const agentMemories = pgTable('agent_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: text('agent_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source'),
  accessCount: integer('access_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
