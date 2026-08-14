import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

const DDL = [
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

import { ensureTraceRun, ingestTraceEvent, ingestTraceSpan } from './dal';

describe('canonical trace DAL', () => {
  beforeEach(() =>
    resetDb(harness.db, ['trace_events', 'trace_spans', 'trace_runs']),
  );

  it('allocates a stable order and suppresses duplicate callbacks', async () => {
    const base = {
      traceId: 'run-dal-1',
      source: 'test',
      type: 'tool',
      status: 'completed',
      startedAt: new Date('2026-08-15T00:00:00Z'),
      idempotencyKey: 'tool:call-1',
    } as const;

    await ensureTraceRun({
      ...base,
      type: 'run',
      status: 'running',
      idempotencyKey: 'run:run-dal-1',
    });
    const first = await ingestTraceSpan({
      ...base,
      spanId: 'tool:call-1',
      input: { path: 'README.md' },
    });
    const duplicate = await ingestTraceSpan({
      ...base,
      spanId: 'tool:call-1',
      input: { path: 'README.md' },
    });
    const event = await ingestTraceEvent({
      ...base,
      type: 'diagnostic',
      spanId: 'tool:call-1',
      eventId: 'event-1',
      idempotencyKey: 'event:1',
      output: { ok: true },
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(Number(first.record.sequence)).toBe(1);
    expect(Number(event.record.sequence)).toBe(2);
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS count FROM "trace_spans"`,
      )
    ).rows as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });
});
