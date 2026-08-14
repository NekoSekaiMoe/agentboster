import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

const DDL = [
  `CREATE TABLE "sessions" (
    "id" uuid PRIMARY KEY,
    "channel" text DEFAULT 'web' NOT NULL,
    "external_thread_id" text,
    "user_id" text,
    "metadata" jsonb
  )`,
  `CREATE TABLE "users" (
    "id" text PRIMARY KEY,
    "roles" text[] DEFAULT '{}'::text[] NOT NULL
  )`,
  `CREATE TABLE "agent_tasks" (
    "id" uuid PRIMARY KEY,
    "session_id" uuid,
    "user_id" text,
    "source" jsonb
  )`,
  `CREATE TABLE "agent_review_logs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "task_id" uuid NOT NULL,
    "trace_id" text,
    "user_id" text,
    "roles" text[],
    "command" text NOT NULL,
    "level" text NOT NULL,
    "score" integer,
    "decision" text NOT NULL,
    "reason" text,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agent_tool_activity_logs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "task_id" uuid,
    "session_id" uuid,
    "trace_id" text,
    "agent_id" text NOT NULL,
    "user_id" text,
    "roles" text[],
    "source" jsonb,
    "sandbox_id" text,
    "model" text,
    "step" integer,
    "tool_call_id" text,
    "tool_name" text NOT NULL,
    "action" text NOT NULL,
    "target" text,
    "arguments" jsonb,
    "result" jsonb,
    "output_text" text,
    "success" boolean DEFAULT false NOT NULL,
    "error" text,
    "duration_ms" integer,
    "started_at" timestamptz NOT NULL,
    "completed_at" timestamptz,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
];

const harness = setupPgLiteTestDb(DDL);

vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
  resolveDriver: () => 'postgres' as const,
}));

vi.mock('@/lib/memory/shared-version', () => ({
  bumpSharedMemoryVersion: vi.fn(),
}));

import { writeReviewLogs, writeToolActivityLogs } from './agentd';

const sessionId = '00000000-0000-0000-0000-000000000001';
const taskId = '00000000-0000-0000-0000-000000000002';

describe('agentd trace propagation', () => {
  beforeEach(async () => {
    await resetDb(harness.db, [
      'agent_tool_activity_logs',
      'agent_review_logs',
      'agent_tasks',
      'users',
      'sessions',
    ]);
    await harness.db.execute(
      sql`INSERT INTO "users" ("id", "roles") VALUES ('user-1', ARRAY['admin'])`,
    );
    await harness.db.execute(
      sql`INSERT INTO "sessions" ("id", "user_id") VALUES (${sessionId}::uuid, 'user-1')`,
    );
    await harness.db.execute(
      sql`INSERT INTO "agent_tasks" ("id", "session_id", "user_id") VALUES (${taskId}::uuid, ${sessionId}::uuid, 'user-1')`,
    );
  });

  it('stores run_id as the canonical trace_id for tool and review callbacks', async () => {
    const [tool] = await writeToolActivityLogs([
      {
        run_id: 'run-web-1',
        session_id: sessionId,
        agent_id: 'main',
        tool_name: 'read',
        action: 'read',
        success: true,
        started_at: '2026-08-14T00:00:00.000Z',
        completed_at: '2026-08-14T00:00:00.050Z',
      },
    ]);
    const [review] = await writeReviewLogs([
      {
        run_id: 'run-web-1',
        task_id: taskId,
        command: 'read README.md',
        level: 'L0',
        score: 0,
        decision: 'allowed',
      },
    ]);

    expect(tool.traceId).toBe('run-web-1');
    expect(review.traceId).toBe('run-web-1');

    const activityRows = (
      await harness.db.execute(
        sql`SELECT "trace_id", "user_id" FROM "agent_tool_activity_logs"`,
      )
    ).rows as Array<{ trace_id: string; user_id: string }>;
    const reviewRows = (
      await harness.db.execute(
        sql`SELECT "trace_id", "user_id" FROM "agent_review_logs"`,
      )
    ).rows as Array<{ trace_id: string; user_id: string }>;
    expect(activityRows).toEqual([
      { trace_id: 'run-web-1', user_id: 'user-1' },
    ]);
    expect(reviewRows).toEqual([{ trace_id: 'run-web-1', user_id: 'user-1' }]);
  });
});
