import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

const DDL = [
  `CREATE TABLE "sessions" (
    "id" uuid PRIMARY KEY,
    "title" text,
    "user_id" text,
    "status" text DEFAULT 'active' NOT NULL,
    "workflow_run_id" text,
    "metadata" jsonb
  )`,
  `CREATE TABLE "messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "session_id" uuid NOT NULL,
    "role" text NOT NULL,
    "step_number" integer,
    "payload" jsonb NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agent_tasks" (
    "id" uuid PRIMARY KEY,
    "session_id" uuid,
    "agent_id" text NOT NULL
  )`,
  `CREATE TABLE "agent_review_logs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "task_id" uuid NOT NULL,
    "trace_id" text,
    "user_id" text,
    "level" text NOT NULL,
    "score" integer,
    "decision" text NOT NULL,
    "command" text NOT NULL,
    "reason" text,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agent_tool_activity_logs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "trace_id" text,
    "session_id" uuid,
    "user_id" text,
    "agent_id" text NOT NULL,
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
    "completed_at" timestamptz
  )`,
];

const harness = setupPgLiteTestDb(DDL);

vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
}));

import { getTrace, listTraces } from './query';

const sessionId = '00000000-0000-0000-0000-000000000001';
const taskId = '00000000-0000-0000-0000-000000000002';
const traceId = 'run-query-1';

describe('trace query integration', () => {
  beforeEach(async () => {
    await resetDb(harness.db, [
      'agent_tool_activity_logs',
      'agent_review_logs',
      'agent_tasks',
      'messages',
      'sessions',
    ]);
    await harness.db.execute(sql`
      INSERT INTO "sessions" (
        "id", "title", "user_id", "status", "metadata"
      ) VALUES (
        ${sessionId}::uuid,
        'Query trace session',
        'user-1',
        'completed',
        ${JSON.stringify({
          workflow: {
            phase: 'completed',
            lastRunId: traceId,
            stoppedAt: '2026-08-14T00:00:02.000Z',
            lastError: null,
          },
        })}::jsonb
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO "messages" (
        "session_id", "role", "step_number", "payload", "created_at"
      ) VALUES (
        ${sessionId}::uuid,
        'assistant',
        0,
        ${JSON.stringify({
          text: 'done',
          finishReason: 'stop',
          usage: { totalTokens: 12 },
          metadata: {
            runId: traceId,
            traceCompletedAt: '2026-08-14T00:00:01.000Z',
            traceDurationMs: 1000,
          },
        })}::jsonb,
        '2026-08-14T00:00:00.000Z'
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO "agent_tasks" ("id", "session_id", "agent_id")
      VALUES (${taskId}::uuid, ${sessionId}::uuid, 'main')
    `);
    await harness.db.execute(sql`
      INSERT INTO "agent_tool_activity_logs" (
        "trace_id", "session_id", "user_id", "agent_id", "tool_name",
        "action", "success", "duration_ms", "started_at", "completed_at"
      ) VALUES (
        ${traceId}, ${sessionId}::uuid, 'user-1', 'main', 'read', 'read',
        true, 50, '2026-08-14T00:00:00.250Z', '2026-08-14T00:00:00.300Z'
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO "agent_review_logs" (
        "task_id", "trace_id", "user_id", "level", "decision", "command",
        "created_at"
      ) VALUES (
        ${taskId}::uuid, ${traceId}, 'user-1', 'L0', 'allowed', 'read README',
        '2026-08-14T00:00:00.200Z'
      )
    `);
  });

  it('lists and loads one correlated trace across all three sources', async () => {
    const list = await listTraces({ userId: 'user-1' }, { limit: 10 });
    expect(list).toEqual([
      expect.objectContaining({
        traceId,
        sessionTitle: 'Query trace session',
        status: 'completed',
        modelStepCount: 1,
        toolCount: 1,
        reviewCount: 1,
        totalTokens: 12,
      }),
    ]);

    const detail = await getTrace(traceId, { userId: 'user-1' });
    expect(detail?.events.map((event) => event.kind)).toEqual([
      'model',
      'review',
      'tool',
    ]);
  });

  it("does not expose another user's trace", async () => {
    await expect(getTrace(traceId, { userId: 'user-2' })).resolves.toBeNull();
  });
});
