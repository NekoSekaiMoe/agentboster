import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

import { TRACE_TABLE_DDL } from '@/lib/core/trace/test-support';

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
    "agent_id" text NOT NULL,
    "session_id" uuid,
    "user_id" text,
    "workspace_id" uuid,
    "command" text NOT NULL,
    "sandbox_type" text DEFAULT 'auto' NOT NULL,
    "sandbox_id" text,
    "source" jsonb,
    "env" jsonb,
    "timeout" integer,
    "status" text DEFAULT 'pending' NOT NULL,
    "result" text,
    "failure_reason" text,
    "attempt" integer DEFAULT 1 NOT NULL,
    "max_attempts" integer DEFAULT 2 NOT NULL,
    "retry_of_task_id" uuid,
    "rerun_of_task_id" uuid,
    "owner_node_id" text,
    "lease_expires_at" timestamptz,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  ...TRACE_TABLE_DDL,
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
      'agent_tasks',
      'trace_spans',
      'trace_runs',
      'users',
      'sessions',
    ]);
    await harness.db.execute(
      sql`INSERT INTO "users" ("id", "roles") VALUES ('user-1', ARRAY['admin'])`,
    );
    await harness.db.execute(
      sql`INSERT INTO "sessions" ("id", "user_id") VALUES (${sessionId}::uuid, 'user-1')`,
    );
    await harness.db.execute(sql`
      INSERT INTO "agent_tasks" (
        "id", "agent_id", "session_id", "user_id", "command"
      ) VALUES (
        ${taskId}::uuid, 'main', ${sessionId}::uuid, 'user-1', 'read README.md'
      )
    `);
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

    const canonicalRows = (
      await harness.db.execute(
        sql`SELECT "type", "trace_id", "user_id", "idempotency_key"
            FROM "trace_spans" ORDER BY "type"`,
      )
    ).rows as Array<{
      type: string;
      trace_id: string;
      user_id: string;
      idempotency_key: string;
    }>;
    expect(canonicalRows).toHaveLength(2);
    expect(canonicalRows.map((row) => row.type)).toEqual(['review', 'tool']);
    expect(canonicalRows.every((row) => row.trace_id === 'run-web-1')).toBe(
      true,
    );
    expect(new Set(canonicalRows.map((row) => row.idempotency_key)).size).toBe(
      2,
    );
  });

  it('keeps both trace_spans rows when toolCallId/toolName/startedAt collide across tasks', async () => {
    const otherTaskId = '00000000-0000-0000-0000-000000000003';
    await harness.db.execute(sql`
      INSERT INTO "agent_tasks" (
        "id", "agent_id", "session_id", "user_id", "command"
      ) VALUES (
        ${otherTaskId}::uuid, 'main', ${sessionId}::uuid, 'user-1', 'ls -la'
      )
    `);

    const startedAt = '2026-08-14T01:00:00.000Z';
    const records = await writeToolActivityLogs([
      {
        run_id: 'run-collide',
        task_id: taskId,
        tool_call_id: 'call_dup',
        tool_name: 'read',
        action: 'read',
        success: true,
        started_at: startedAt,
        completed_at: '2026-08-14T01:00:00.010Z',
      },
      {
        run_id: 'run-collide',
        task_id: otherTaskId,
        tool_call_id: 'call_dup',
        tool_name: 'read',
        action: 'read',
        success: true,
        started_at: startedAt,
        completed_at: '2026-08-14T01:00:00.010Z',
      },
    ]);
    expect(records).toHaveLength(2);

    const rows = (
      await harness.db.execute(
        sql`SELECT "span_id", "task_id", "type"
            FROM "trace_spans" WHERE "trace_id" = 'run-collide'`,
      )
    ).rows as Array<{ span_id: string; task_id: string; type: string }>;
    // unique (trace_id, span_id) did not reject the second insert and both
    // records landed as distinct spans.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.type === 'tool')).toBe(true);
    expect(new Set(rows.map((row) => row.span_id)).size).toBe(2);
    expect(new Set(rows.map((row) => row.task_id))).toEqual(
      new Set([taskId, otherTaskId]),
    );
  });

  it('keeps both review rows when decision differs for the same task+level+command', async () => {
    // The idempotency keys differ (decision is part of the key) but the
    // old spanId `review:${taskId}:${level}:${command}` did not include
    // the decision, so `unique (trace_id, span_id)` rejected the second
    // row with a 23505 — onConflictDoNothing only arbitrates the
    // idempotency-key index, not the span-id one.
    const records = await writeReviewLogs([
      {
        run_id: 'run-review-dup',
        task_id: taskId,
        command: 'rm -rf /tmp/x',
        level: 'L1',
        score: 10,
        decision: 'allowed',
      },
      {
        run_id: 'run-review-dup',
        task_id: taskId,
        command: 'rm -rf /tmp/x',
        level: 'L1',
        score: 90,
        decision: 'blocked',
      },
    ]);
    expect(records).toHaveLength(2);

    const rows = (
      await harness.db.execute(
        sql`SELECT "span_id", "status", "idempotency_key", "output"
            FROM "trace_spans" WHERE "trace_id" = 'run-review-dup' AND "type" = 'review'`,
      )
    ).rows as Array<{
      span_id: string;
      status: string;
      idempotency_key: string;
      output: { decision?: string } | null;
    }>;
    expect(rows).toHaveLength(2);
    // spanIds are now unique per record (decision disambiguates them).
    expect(new Set(rows.map((row) => row.span_id)).size).toBe(2);
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.output?.decision ?? null))).toEqual(
      new Set(['allowed', 'blocked']),
    );
  });

  it('is idempotent when the same callback batch is replayed with the same idempotency keys', async () => {
    const toolBatch = [
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
    ];
    const reviewBatch = [
      {
        run_id: 'run-web-1',
        task_id: taskId,
        command: 'read README.md',
        level: 'L0',
        score: 0,
        decision: 'allowed',
      },
    ];

    const firstTool = await writeToolActivityLogs(toolBatch);
    const firstReview = await writeReviewLogs(reviewBatch);
    expect(firstTool[0].idempotencyKey).toBeTruthy();
    expect(firstReview[0].idempotencyKey).toBeTruthy();
    // Replays must not burn sequence slots: capture next_sequence right
    // after the initial writes and assert it is unchanged after replay.
    const [beforeReplay] = (
      await harness.db.execute(
        sql`SELECT "next_sequence" FROM "trace_runs" WHERE "trace_id" = 'run-web-1'`,
      )
    ).rows as Array<{ next_sequence: string | number }>;

    const replayTool = await writeToolActivityLogs(toolBatch);
    const replayReview = await writeReviewLogs(reviewBatch);
    // Replays return the same records, not new ones.
    expect(replayTool[0].id).toBe(firstTool[0].id);
    expect(replayReview[0].id).toBe(firstReview[0].id);

    const [afterReplay] = (
      await harness.db.execute(
        sql`SELECT "next_sequence" FROM "trace_runs" WHERE "trace_id" = 'run-web-1'`,
      )
    ).rows as Array<{ next_sequence: string | number }>;
    expect(String(afterReplay?.next_sequence)).toBe(
      String(beforeReplay?.next_sequence),
    );

    const rows = (
      await harness.db.execute(
        sql`SELECT "type", "trace_id", "status", "idempotency_key"
            FROM "trace_spans" ORDER BY "type"`,
      )
    ).rows as Array<{
      type: string;
      trace_id: string;
      status: string;
      idempotency_key: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type)).toEqual(['review', 'tool']);
    expect(rows.every((row) => row.trace_id === 'run-web-1')).toBe(true);
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2);
    // Review spans now carry a lifecycle status instead of the decision.
    const reviewRow = rows.find((row) => row.type === 'review');
    expect(reviewRow?.status).toBe('completed');
  });
});
