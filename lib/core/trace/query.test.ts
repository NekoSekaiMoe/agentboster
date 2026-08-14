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
  `CREATE TABLE "trace_runs" (
    "trace_id" text PRIMARY KEY,
    "span_id" text NOT NULL,
    "parent_span_id" text,
    "sequence" bigint DEFAULT 0 NOT NULL,
    "source" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "started_at" timestamptz DEFAULT now() NOT NULL,
    "completed_at" timestamptz,
    "duration_ms" integer,
    "user_id" text,
    "session_id" uuid,
    "task_id" uuid,
    "workspace_id" uuid,
    "node_id" text,
    "agent_id" text,
    "input" jsonb,
    "output" jsonb,
    "error" jsonb,
    "metadata" jsonb,
    "idempotency_key" text NOT NULL,
    "next_sequence" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    UNIQUE ("trace_id", "idempotency_key")
  )`,
  `CREATE TABLE "trace_spans" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "trace_id" text NOT NULL,
    "span_id" text NOT NULL,
    "parent_span_id" text,
    "sequence" bigint NOT NULL,
    "source" text NOT NULL,
    "type" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "started_at" timestamptz DEFAULT now() NOT NULL,
    "completed_at" timestamptz,
    "duration_ms" integer,
    "user_id" text,
    "session_id" uuid,
    "task_id" uuid,
    "workspace_id" uuid,
    "node_id" text,
    "agent_id" text,
    "input" jsonb,
    "output" jsonb,
    "error" jsonb,
    "metadata" jsonb,
    "idempotency_key" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    UNIQUE ("trace_id", "span_id"),
    UNIQUE ("trace_id", "idempotency_key")
  )`,
  `CREATE TABLE "trace_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "event_id" text NOT NULL,
    "trace_id" text NOT NULL,
    "span_id" text,
    "parent_span_id" text,
    "sequence" bigint NOT NULL,
    "source" text NOT NULL,
    "type" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "started_at" timestamptz DEFAULT now() NOT NULL,
    "completed_at" timestamptz,
    "duration_ms" integer,
    "user_id" text,
    "session_id" uuid,
    "task_id" uuid,
    "workspace_id" uuid,
    "node_id" text,
    "agent_id" text,
    "input" jsonb,
    "output" jsonb,
    "error" jsonb,
    "metadata" jsonb,
    "idempotency_key" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    UNIQUE ("trace_id", "event_id"),
    UNIQUE ("trace_id", "idempotency_key")
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
const otherSessionId = '00000000-0000-0000-0000-000000000003';
const traceId = 'run-query-1';

async function insertTrace(
  id: string,
  userId: string,
  currentSessionId: string,
) {
  await harness.db.execute(sql`
    INSERT INTO "trace_runs" (
      "trace_id", "span_id", "source", "status", "started_at",
      "completed_at", "duration_ms", "user_id", "session_id",
      "idempotency_key", "next_sequence"
    ) VALUES (
      ${id}, ${`run:${id}`}, 'test', 'completed',
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:02.000Z', 2000,
      ${userId}, ${currentSessionId}::uuid, ${`run:${id}`}, 3
    )
  `);
  await harness.db.execute(sql`
    INSERT INTO "trace_spans" (
      "trace_id", "span_id", "sequence", "source", "type", "status",
      "started_at", "completed_at", "duration_ms", "user_id", "session_id",
      "agent_id", "output", "metadata", "idempotency_key"
    ) VALUES (
      ${id}, ${`model:${id}:0`}, 1, 'workflow', 'model', 'completed',
      '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:01.000Z', 1000,
      ${userId}, ${currentSessionId}::uuid, 'main',
      ${JSON.stringify({ text: 'done', finishReason: 'stop', usage: { totalTokens: 12 } })}::jsonb,
      ${JSON.stringify({ step: 0 })}::jsonb, ${`model:${id}:0`}
    ), (
      ${id}, ${`review:${id}:1`}, 2, 'agentd', 'review', 'allowed',
      '2026-08-14T00:00:00.200Z', '2026-08-14T00:00:00.200Z', 0,
      ${userId}, ${currentSessionId}::uuid, 'main',
      ${JSON.stringify({ decision: 'allowed' })}::jsonb,
      ${JSON.stringify({ level: 'L0', decision: 'allowed', command: 'read README' })}::jsonb,
      ${`review:${id}:1`}
    ), (
      ${id}, ${`tool:${id}:1`}, 3, 'workflow', 'tool', 'completed',
      '2026-08-14T00:00:00.250Z', '2026-08-14T00:00:00.300Z', 50,
      ${userId}, ${currentSessionId}::uuid, 'main',
      ${JSON.stringify({ path: 'README.md' })}::jsonb,
      ${JSON.stringify({ ok: true, toolName: 'read', action: 'read' })}::jsonb,
      ${`tool:${id}:1`}
    )
  `);
}

describe('canonical trace query', () => {
  beforeEach(async () => {
    await resetDb(harness.db, [
      'trace_events',
      'trace_spans',
      'trace_runs',
      'sessions',
    ]);
    await harness.db.execute(sql`
      INSERT INTO "sessions" ("id", "title", "user_id", "status")
      VALUES (${sessionId}::uuid, 'Query trace session', 'user-1', 'completed')
    `);
    await insertTrace(traceId, 'user-1', sessionId);
  });

  it('lists and loads one canonical trace across model, review, and tool spans', async () => {
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

  it("does not join another user's session metadata onto a scoped trace", async () => {
    const mismatchedTraceId = 'run-mismatched-session';
    await harness.db.execute(sql`
      INSERT INTO "sessions" ("id", "title", "user_id", "status")
      VALUES (
        ${otherSessionId}::uuid, 'Other user private session', 'user-2', 'completed'
      )
    `);
    await insertTrace(mismatchedTraceId, 'user-1', otherSessionId);

    const detail = await getTrace(mismatchedTraceId, { userId: 'user-1' });

    expect(detail?.summary).toMatchObject({
      sessionTitle: null,
      status: 'completed',
      userId: 'user-1',
    });
  });
});
