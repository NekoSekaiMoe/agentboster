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

// Mutable driver override for atomicWriteMode(): the neon branch of
// ingestChildRecord runs the same statements sequentially instead of inside
// db.transaction(), which PGlite executes fine — the mock only reroutes the
// branch decision. The default 'postgres' exercises the real transaction
// path against PGlite's interactive transactions.
const atomicMode: { current: 'neon' | 'postgres' } = { current: 'postgres' };
vi.mock('@/lib/core/db/atomic', () => ({
  atomicWriteMode: () => atomicMode.current,
}));

import {
  ensureTraceRun,
  finalizeTraceRun,
  ingestTraceEvent,
  ingestTraceSpan,
} from './dal';

describe('canonical trace DAL', () => {
  beforeEach(() => {
    atomicMode.current = 'postgres';
    return resetDb(harness.db, ['trace_events', 'trace_spans', 'trace_runs']);
  });

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

    expect(first).not.toBeNull();
    expect(first?.duplicate).toBe(false);
    expect(duplicate?.duplicate).toBe(true);
    expect(Number(first?.record.sequence)).toBe(1);
    expect(Number(event?.record.sequence)).toBe(2);
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS count FROM "trace_spans"`,
      )
    ).rows as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });

  it('ingests without an interactive transaction on the neon branch', async () => {
    atomicMode.current = 'neon';
    const base = {
      traceId: 'run-dal-neon',
      source: 'test',
      type: 'tool',
      status: 'completed',
      startedAt: new Date('2026-08-15T00:00:00Z'),
      idempotencyKey: 'tool:call-neon',
    } as const;

    await ensureTraceRun({
      ...base,
      type: 'run',
      status: 'running',
      idempotencyKey: 'run:run-dal-neon',
    });
    const first = await ingestTraceSpan({ ...base, spanId: 'tool:call-neon' });
    const duplicate = await ingestTraceSpan({
      ...base,
      spanId: 'tool:call-neon',
    });
    const event = await ingestTraceEvent({
      ...base,
      type: 'diagnostic',
      spanId: 'tool:call-neon',
      eventId: 'event-neon',
      idempotencyKey: 'event:neon',
      output: { ok: true },
    });

    expect(first?.duplicate).toBe(false);
    expect(duplicate?.duplicate).toBe(true);
    expect(Number(first?.record.sequence)).toBe(1);
    // The neon branch has no transaction to roll back the duplicate's
    // sequence allocation, so the lost idempotency race burns a gap: the
    // duplicate consumed sequence 2 and the event lands on 3 (the postgres
    // branch above would put it on 2).
    expect(Number(event?.record.sequence)).toBe(3);
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS count FROM "trace_spans"`,
      )
    ).rows as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });

  it('replays ensureTraceRun without duplicating the run row', async () => {
    const input = {
      traceId: 'run-dal-replay',
      source: 'test',
      type: 'run',
      status: 'running',
      startedAt: new Date('2026-08-15T00:00:00Z'),
      idempotencyKey: 'run:run-dal-replay',
    } as const;

    const first = await ensureTraceRun(input);
    const replay = await ensureTraceRun(input);

    expect(first?.duplicate).toBe(false);
    expect(replay?.duplicate).toBe(true);
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS count FROM "trace_runs" WHERE "trace_id" = 'run-dal-replay'`,
      )
    ).rows as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });

  it('keeps the terminal status on a repeated finalizeTraceRun', async () => {
    const traceId = 'run-dal-final';
    await ensureTraceRun({
      traceId,
      source: 'test',
      type: 'run',
      status: 'running',
      startedAt: new Date('2026-08-15T00:00:00Z'),
      idempotencyKey: `run:${traceId}`,
    });
    const first = await finalizeTraceRun({
      traceId,
      status: 'completed',
      completedAt: new Date('2026-08-15T00:01:00Z'),
    });
    const replay = await finalizeTraceRun({
      traceId,
      status: 'failed',
      error: { message: 'late attempt to overwrite the terminal status' },
    });

    expect(first?.status).toBe('completed');
    expect(replay).toBeNull();
    const rows = (
      await harness.db.execute(
        sql`SELECT "status" FROM "trace_runs" WHERE "trace_id" = ${traceId}`,
      )
    ).rows as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('completed');
  });
});
