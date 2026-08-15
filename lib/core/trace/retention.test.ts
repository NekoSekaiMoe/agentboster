import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

import { TRACE_TABLE_DDL } from './test-support';

const DDL = [...TRACE_TABLE_DDL];

const harness = setupPgLiteTestDb(DDL);

vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
}));

import { traceRuns } from '@/lib/core/db/schema';
import { cleanupExpiredTraces, TRACE_CLEANUP_BATCH_SIZE } from './retention';

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

  it('emits a FOR UPDATE lock from the actual cleanup query', async () => {
    // The lock is the fix for the select->delete race: the SELECT that
    // decides the delete set must take row locks so a concurrent ingest
    // (which updates trace_runs via allocateSequence) serializes behind
    // the cleanup instead of interleaving between select and delete.
    // PGlite is single-connection, so true interleaving cannot be
    // simulated; instead wrap the tx handle passed to the REAL function
    // and record the emitted SQL (any query-builder method that returns
    // an object with toSQL() gets re-wrapped) so the assertion observes
    // the code under test, not an independently constructed query.
    await insertRun('any-run', new Date(Date.now() - OLD_DAYS * 86_400_000));
    let lastSelectSql: string | null = null;

    /** Wrap a query builder so any SQL it eventually emits is recorded. */
    const wrapBuilder = (builder: unknown): unknown =>
      new Proxy(builder as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const returned = value.apply(target, args);
            if (
              returned &&
              typeof (returned as { toSQL?: unknown }).toSQL === 'function'
            ) {
              // Builders expose toSQL() at every chain stage; keep only the
              // latest SQL per statement so the FINAL form (with
              // where/limit/for) is what gets asserted.
              const text = (returned as { toSQL: () => { sql: string } })
                .toSQL()
                .sql.toLowerCase();
              if (text.startsWith('select')) {
                lastSelectSql = text;
              }
            }
            // Chainable builders (from/where/orderBy/limit) keep being
            // wrapped so the final executable form is captured too.
            return wrapBuilder(returned);
          };
        },
      });

    const spyingTx = new Proxy(asCleanupTx(harness.db), {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'select' && typeof value === 'function') {
          return (...args: unknown[]) => wrapBuilder(value.apply(target, args));
        }
        return value;
      },
    });

    const result = await cleanupExpiredTraces(spyingTx, OLD_DAYS);

    expect(result.runs).toBe(1);
    // The SELECT stages were captured from the real cleanup query.
    expect(lastSelectSql).not.toBeNull();
    expect(lastSelectSql).toContain('for update');
    expect(lastSelectSql).toContain('limit');
  });

  it('deletes at most TRACE_CLEANUP_BATCH_SIZE runs per call', async () => {
    const cutoff = new Date(Date.now() - OLD_DAYS * 24 * 60 * 60 * 1000);
    const total = TRACE_CLEANUP_BATCH_SIZE + 3;
    for (let i = 0; i < total; i++) {
      await insertRun(`expired-${i}`, new Date(cutoff.getTime() - i * 1000));
    }

    const first = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );
    expect(first.runs).toBe(TRACE_CLEANUP_BATCH_SIZE);

    // The wrapper drains the remainder across additional batches.
    const second = await harness.db.transaction((tx) =>
      cleanupExpiredTraces(asCleanupTx(tx), OLD_DAYS),
    );
    expect(second.runs).toBe(total - TRACE_CLEANUP_BATCH_SIZE);
    expect(await counts()).toEqual({ runs: 0, spans: 0, events: 0 });
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
