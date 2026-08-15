import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

// Same DDL as dal.test.ts: the three canonical trace tables.
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

import { traceRuns } from '@/lib/core/db/schema';
import { cleanupExpiredTraces } from './retention';

/** PGlite transactions only differ from the neon/node-postgres tx type in
 *  their query-result HKT; cast through the narrow structural surface the
 *  cleanup uses (runtime behavior is identical). */
type CleanupTx = Parameters<typeof cleanupExpiredTraces>[0];
const asCleanupTx = (tx: unknown) => tx as CleanupTx;

const OLD_DAYS = 200;

async function insertRun(traceId: string, startedAt: Date): Promise<void> {
  await harness.db.insert(traceRuns).values({
    traceId,
    spanId: `run:${traceId}`,
    source: 'test',
    status: 'completed',
    startedAt,
    idempotencyKey: `run:${traceId}`,
  });
}

async function counts(): Promise<{
  runs: number;
  spans: number;
  events: number;
}> {
  const [row] = (
    await harness.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM "trace_runs") AS runs,
        (SELECT count(*)::int FROM "trace_spans") AS spans,
        (SELECT count(*)::int FROM "trace_events") AS events
    `)
  ).rows as Array<{ runs: number; spans: number; events: number }>;
  return { runs: row.runs, spans: row.spans, events: row.events };
}

describe('trace retention cleanup', () => {
  beforeEach(() =>
    resetDb(harness.db, ['trace_events', 'trace_spans', 'trace_runs']),
  );

  it('deletes expired runs and their children, keeps fresh runs', async () => {
    const cutoff = new Date(Date.now() - OLD_DAYS * 24 * 60 * 60 * 1000);
    await insertRun('expired-run', new Date(cutoff.getTime() - 60_000));
    await insertRun('expired-run-2', new Date(cutoff.getTime() - 120_000));
    await insertRun('fresh-run', new Date());
    await harness.db.execute(sql`
      INSERT INTO "trace_spans" ("trace_id", "span_id", "sequence", "source",
        "type", "status", "started_at", "idempotency_key")
      VALUES ('expired-run', 'span-1', 1, 'test', 'tool', 'completed',
        now(), 'tool:1'),
        ('fresh-run', 'span-2', 1, 'test', 'tool', 'completed',
        now(), 'tool:2')
    `);
    await harness.db.execute(sql`
      INSERT INTO "trace_events" ("event_id", "trace_id", "sequence", "source",
        "type", "status", "started_at", "idempotency_key")
      VALUES ('event-1', 'expired-run', 2, 'test', 'diagnostic', 'completed',
        now(), 'event:1')
    `);

    const result = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );

    expect(result).toEqual({ events: 1, spans: 1, runs: 2 });
    expect(await counts()).toEqual({ runs: 1, spans: 1, events: 0 });
    const [remaining] = (
      await harness.db.execute(sql`SELECT "trace_id" FROM "trace_runs"`)
    ).rows as Array<{ trace_id: string }>;
    expect(remaining.trace_id).toBe('fresh-run');
  });

  it('is idempotent: a second cleanup over the same window deletes nothing', async () => {
    const cutoff = new Date(Date.now() - OLD_DAYS * 24 * 60 * 60 * 1000);
    await insertRun('expired-run', new Date(cutoff.getTime() - 60_000));

    const first = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );
    // Second call under the FOR UPDATE lock semantics: the run rows are
    // gone, so the locked select finds nothing and no delete fires.
    const second = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );

    expect(first.runs).toBe(1);
    expect(second).toEqual({ events: 0, spans: 0, runs: 0 });
    expect(await counts()).toEqual({ runs: 0, spans: 0, events: 0 });
  });

  it('emits a FOR UPDATE lock on the selected run rows', async () => {
    // The lock is the fix for the select->delete race: the SELECT that
    // decides the delete set must take row locks so a concurrent ingest
    // (which updates trace_runs via allocateSequence) serializes behind
    // the cleanup instead of interleaving between select and delete.
    // PGlite is single-connection, so true interleaving cannot be
    // simulated; assert the lock actually makes it into the emitted SQL.
    const query = harness.db
      .select({ traceId: traceRuns.traceId })
      .from(traceRuns)
      .for('update');
    const { sql: emitted } = query.toSQL();
    expect(emitted.toLowerCase()).toContain('for update');

    await insertRun('any-run', new Date());
    const rows = await query;
    expect(rows.map((row) => row.traceId)).toEqual(['any-run']);
  });

  it('scopes deletes to exactly the trace ids the locked select captured', async () => {
    const cutoff = new Date(Date.now() - OLD_DAYS * 24 * 60 * 60 * 1000);
    await insertRun('expired-run', new Date(cutoff.getTime() - 60_000));
    await insertRun('fresh-run', new Date());
    // A span on the fresh run must survive even though its run row
    // shares the table with the expired one — deletes are per-trace_id.
    await harness.db.execute(sql`
      INSERT INTO "trace_spans" ("trace_id", "span_id", "sequence", "source",
        "type", "status", "started_at", "idempotency_key")
      VALUES
        ('expired-run', 'span-old', 1, 'test', 'tool', 'completed', now(), 'tool:old'),
        ('fresh-run', 'span-new', 1, 'test', 'tool', 'completed', now(), 'tool:new')
    `);

    const result = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );

    expect(result).toEqual({ events: 0, spans: 1, runs: 1 });
    const survivingSpans = (
      await harness.db.execute(sql`SELECT "span_id" FROM "trace_spans"`)
    ).rows as Array<{ span_id: string }>;
    expect(survivingSpans.map((row) => row.span_id)).toEqual(['span-new']);
  });
});
