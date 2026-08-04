/**
 * Unit tests for recordRecallHits (DAL).
 *
 * The db handle is mocked, but instead of asserting call counts we
 * compile the exact UPDATE the DAL builds through drizzle's PgDialect
 * and assert on the resulting SQL text + bound params: ownership in the
 * WHERE clause, the parameterized jsonb dedupe/append/truncate
 * expression, per-turn hit deduplication, and warn-and-continue on
 * failure.
 */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updates, state, warnSpy } = vi.hoisted(() => ({
  updates: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    condition: unknown;
  }>,
  state: { failNextUpdate: false },
  warnSpy: vi.fn(),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/db')>();
  return {
    ...actual,
    db: {
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            updates.push({ table, values, condition });
            if (state.failNextUpdate) {
              state.failNextUpdate = false;
              return Promise.reject(new Error('db exploded'));
            }
            return Promise.resolve([]);
          },
        }),
      }),
    },
  };
});

import {
  MAX_RECALL_QUERY_HASHES,
  recordRecallHits,
} from '@/lib/core/db/memory/long-term';

const dialect = new PgDialect();

function compile(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

describe('recordRecallHits', () => {
  beforeEach(() => {
    updates.length = 0;
    state.failNextUpdate = false;
    warnSpy.mockClear();
  });

  it('deduplicates hits by memoryId — one UPDATE per unique memory', async () => {
    await recordRecallHits({
      userId: 'u1',
      hits: [
        { memoryId: 'm1', queryHash: 'a' },
        { memoryId: 'm1', queryHash: 'b' },
        { memoryId: 'm2', queryHash: 'c' },
      ],
    });

    expect(updates).toHaveLength(2);
  });

  it('enforces ownership in the WHERE clause (id + userId)', async () => {
    await recordRecallHits({
      userId: 'u1',
      hits: [{ memoryId: 'm1', queryHash: 'abc' }],
    });

    const where = compile(updates[0].condition);
    expect(where.sql).toContain('"id"');
    expect(where.sql).toContain('"user_id"');
    expect(where.params).toEqual(['m1', 'u1']);
  });

  it('builds a parameterized jsonb dedupe/append/truncate expression', async () => {
    await recordRecallHits({
      userId: 'u1',
      hits: [{ memoryId: 'm1', queryHash: 'abc' }],
    });

    const { values } = updates[0];
    // recall count + last-recalled-at still updated alongside the hashes.
    expect(compile(values.recallCount).sql).toContain('recall_count');
    expect(values.lastRecalledAt).toBeInstanceOf(Date);

    const hashes = compile(values.recallQueryHashes);
    expect(hashes.sql).toContain('jsonb_array_elements_text');
    expect(hashes.sql).toContain('jsonb_agg');
    // The day+query bucket and the cap are bound params, not inlined.
    expect(hashes.params).toContain(
      `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}:abc`,
    );
    expect(hashes.params).toContain(MAX_RECALL_QUERY_HASHES);
  });

  it('logs a warning and continues with remaining hits when a row fails', async () => {
    state.failNextUpdate = true;
    await recordRecallHits({
      userId: 'u1',
      hits: [
        { memoryId: 'm1', queryHash: 'a' },
        { memoryId: 'm2', queryHash: 'b' },
      ],
    });

    // The first hit rejects; the second must still be attempted.
    expect(updates).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'record_recall_hits:row_failed',
      expect.objectContaining({ memoryId: 'm1' }),
    );
  });
});
