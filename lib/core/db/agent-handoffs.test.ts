/**
 * Tests for the agent_handoffs DB layer.
 *
 * Phase B of the multi-agent collaboration design. The DB layer is
 * emulated with an in-memory store so the tests run without Postgres.
 *
 * Implementation note: vi.mock factories are hoisted above the test
 * body, so any state they touch must be created via vi.hoisted() to be
 * visible inside the factory. drizzle-orm's query operators (eq/and/or/
 * isNull) are replaced with predicate fns; the `db` mock consumes those
 * predicates directly to filter the in-memory store.
 *
 * Run via: yarn test lib/core/db/agent-handoffs.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockRow {
  id: string;
  fromSessionId?: string;
  toSessionId?: string;
  runId?: string;
  barrierId?: string;
  key: string;
  payload: unknown;
  createdAt: Date;
}

// Hoisted state — visible inside vi.mock factories.
const hoisted = vi.hoisted(() => {
  const store: MockRow[] = [];
  let nextId = 1;
  return {
    store,
    nextId: () => `row_${nextId++}`,
    reset: () => {
      store.length = 0;
      nextId = 1;
    },
  };
});

type Pred = (row: MockRow) => boolean;

vi.mock('drizzle-orm', () => {
  const eq =
    (col: keyof MockRow, value: unknown): Pred =>
    (row) =>
      row[col] === value;
  const isNull =
    (col: keyof MockRow): Pred =>
    (row) =>
      row[col] == null;
  const and =
    (...preds: Pred[]): Pred =>
    (row) =>
      preds.every((p) => p(row));
  const or =
    (...preds: Pred[]): Pred =>
    (row) =>
      preds.some((p) => p(row));
  const asc = () => 'asc';
  return { eq, isNull, and, or, asc };
});

vi.mock('@/lib/core/db', () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (input: Record<string, unknown>) => ({
        returning: async () => {
          const row: MockRow = {
            id: hoisted.nextId(),
            fromSessionId: input.fromSessionId as string | undefined,
            toSessionId: input.toSessionId as string | undefined,
            runId: input.runId as string | undefined,
            barrierId: input.barrierId as string | undefined,
            key: input.key as string,
            payload: input.payload,
            createdAt: new Date(),
          };
          hoisted.store.push(row);
          return [row];
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: (predicate: Pred) => ({
        returning: async () => {
          const idx = hoisted.store.findIndex(predicate);
          if (idx === -1) return [];
          const [removed] = hoisted.store.splice(idx, 1);
          return [removed];
        },
      }),
    }),
    select: () => ({
      from: (_table: unknown) => ({
        where: (predicate: Pred) => ({
          orderBy: () =>
            hoisted.store
              .filter(predicate)
              .sort((a, b) => a.id.localeCompare(b.id)),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));
vi.mock('@/lib/core/db/schema', () => ({
  // Mock keys must match MockRow property names so drizzle-orm operators
  // (eq/and/or/isNull) can use the same key on both sides. The real
  // schema uses snake_case column names but that's irrelevant for the
  // in-memory store.
  agentHandoffs: {
    id: 'id',
    fromSessionId: 'fromSessionId',
    toSessionId: 'toSessionId',
    runId: 'runId',
    barrierId: 'barrierId',
    key: 'key',
    payload: 'payload',
    createdAt: 'createdAt',
  },
}));
vi.mock('@/lib/workflow/agent/barrier', () => ({
  getBarrierRegistry: () => ({
    release: vi.fn(async () => null),
  }),
}));

// Import AFTER mocks are registered.
import {
  putHandoff,
  takeHandoff,
  peekHandoffs,
  listHandoffsByFromSession,
  releaseLinkedBarrier,
} from './agent-handoffs';

describe('agent-handoffs DB layer', () => {
  beforeEach(() => {
    hoisted.reset();
  });

  describe('putHandoff', () => {
    it('inserts a row with the given fields', async () => {
      const row = await putHandoff({
        fromSessionId: '11111111-1111-1111-1111-111111111111',
        toSessionId: '22222222-2222-2222-2222-222222222222',
        key: 'result',
        payload: { ok: true, n: 42 },
      });
      expect(row.id).toMatch(/^row_\d+$/);
      expect(row.key).toBe('result');
      expect(row.payload).toEqual({ ok: true, n: 42 });
      expect(row.toSessionId).toBe('22222222-2222-2222-2222-222222222222');
    });

    it('allows broadcast (toSessionId null)', async () => {
      const row = await putHandoff({
        fromSessionId: '11111111-1111-1111-1111-111111111111',
        key: 'note',
        payload: 'hello',
      });
      expect(row.toSessionId).toBeUndefined();
    });
  });

  describe('takeHandoff', () => {
    it('returns the oldest targeted row and deletes it', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 'first',
      });
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 'second',
      });

      const first = await takeHandoff({ forSessionId: S2, key: 'k' });
      expect(first?.payload).toBe('first');
      const second = await takeHandoff({ forSessionId: S2, key: 'k' });
      expect(second?.payload).toBe('second');
      const third = await takeHandoff({ forSessionId: S2, key: 'k' });
      expect(third).toBeNull();
    });

    it('matches broadcasts when broadcastsOnly is false', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      await putHandoff({ fromSessionId: S1, key: 'k', payload: 'broadcast' });

      const got = await takeHandoff({ forSessionId: S2, key: 'k' });
      expect(got?.payload).toBe('broadcast');
    });

    it('does NOT match targeted rows for other sessions', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      const S3 = '33333333-3333-3333-3333-333333333333';
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 'for-S2',
      });

      const got = await takeHandoff({ forSessionId: S3, key: 'k' });
      expect(got).toBeNull();
    });

    it('broadcastsOnly excludes targeted rows', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 'targeted',
      });
      await putHandoff({ fromSessionId: S1, key: 'k', payload: 'broadcast' });

      const got = await takeHandoff({
        forSessionId: S2,
        key: 'k',
        broadcastsOnly: true,
      });
      expect(got?.payload).toBe('broadcast');
    });

    it('is destructive (a second take returns null)', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      await putHandoff({ fromSessionId: S1, key: 'k', payload: 'once' });
      await takeHandoff({ forSessionId: S1, key: 'k' });
      const again = await takeHandoff({ forSessionId: S1, key: 'k' });
      expect(again).toBeNull();
    });
  });

  describe('peekHandoffs', () => {
    it('lists matching rows without deleting', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 1,
      });
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'k',
        payload: 2,
      });

      const rows = await peekHandoffs({ forSessionId: S2, key: 'k' });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.payload)).toEqual([1, 2]);

      // Still there after peek.
      const rows2 = await peekHandoffs({ forSessionId: S2, key: 'k' });
      expect(rows2).toHaveLength(2);
    });
  });

  describe('listHandoffsByFromSession', () => {
    it('lists everything a session has emitted', async () => {
      const S1 = '11111111-1111-1111-1111-111111111111';
      const S2 = '22222222-2222-2222-2222-222222222222';
      await putHandoff({ fromSessionId: S1, key: 'a', payload: 'x' });
      await putHandoff({
        fromSessionId: S1,
        toSessionId: S2,
        key: 'b',
        payload: 'y',
      });
      await putHandoff({ fromSessionId: S2, key: 'c', payload: 'z' });

      const s1Rows = await listHandoffsByFromSession(S1);
      expect(s1Rows).toHaveLength(2);
      expect(s1Rows.map((r) => r.key).sort()).toEqual(['a', 'b']);
    });
  });

  describe('releaseLinkedBarrier', () => {
    it('does not throw when the registry.release returns null', async () => {
      await expect(
        releaseLinkedBarrier('bar_x', 'take:k', true, { empty: true }),
      ).resolves.toBeUndefined();
    });
  });
});
