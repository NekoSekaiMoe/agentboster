/**
 * Tests for the Session Goal DAL functions (setSessionGoal /
 * clearSessionGoal / incrementGoalCounters / getSessionGoalState).
 *
 * The DB layer is emulated with an in-memory store so the tests run
 * without Postgres, mirroring agent-handoffs.test.ts. drizzle-orm's
 * query operators (eq) are replaced with predicate fns; the `db` mock
 * consumes those predicates directly. SQL-side increment expressions
 * (`col + n`) are passed through as plain numbers when the test seeds
 * the store, so incrementGoalCounters is exercised against real
 * arithmetic.
 *
 * Run via: yarn test lib/core/db/chat-goal.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockSessionRow {
  id: string;
  goalText: string | null;
  goalSetAt: Date | null;
  hiddenContinuationCount: number;
  consecutiveNonProgress: number;
  lastEvalReason: string | null;
}

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

// Hoisted state — visible inside vi.mock factories.
const hoisted = vi.hoisted(() => {
  const store: MockSessionRow[] = [];
  return {
    store,
    reset: () => {
      store.length = 0;
    },
    seed: (row: Partial<MockSessionRow> & { id: string }): MockSessionRow => {
      const full: MockSessionRow = {
        id: row.id,
        goalText: row.goalText ?? null,
        goalSetAt: row.goalSetAt ?? null,
        hiddenContinuationCount: row.hiddenContinuationCount ?? 0,
        consecutiveNonProgress: row.consecutiveNonProgress ?? 0,
        lastEvalReason: row.lastEvalReason ?? null,
      };
      store.push(full);
      return full;
    },
  };
});

type Pred = (row: MockSessionRow) => boolean;

vi.mock('drizzle-orm', () => {
  const eq =
    (col: keyof MockSessionRow, value: unknown): Pred =>
    (row) =>
      row[col] === value;
  // `sql` template tag — returns the interpolated number for the
  // increment expressions (col + n). The db mock applies these by
  // detecting the { kind: 'inc', col, delta } shape below.
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    // The DAL writes: sql`COALESCE(${schema.sessions.hiddenContinuationCount}, 0) + ${delta}`
    // → strings = ['COALESCE(', ', 0) + ', ''] and values = [colRef, delta].
    // colRef is the schema mock below (a string key like
    // 'hiddenContinuationCount'); the COALESCE(...) wrapper is cosmetic
    // (NULL defense) and does not change which positional value is the
    // column vs. the delta. We synthesize an increment descriptor.
    const colRef = values[0] as string;
    const delta = values[1] as number;
    return { kind: 'inc' as const, col: colRef, delta };
  };
  return { eq, sql };
});

vi.mock('@/lib/core/db', () => {
  const schema = {
    // Mock keys map to MockSessionRow property names. The `sql` template
    // above receives the first interpolated value (the column ref),
    // which is one of these keys.
    sessions: {
      id: 'id',
      goalText: 'goalText',
      goalSetAt: 'goalSetAt',
      hiddenContinuationCount: 'hiddenContinuationCount',
      consecutiveNonProgress: 'consecutiveNonProgress',
      lastEvalReason: 'lastEvalReason',
    },
  };
  const db = {
    update: (_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: Pred) => ({
          returning: async () => {
            const row = hoisted.store.find(predicate);
            if (!row) return [] as MockSessionRow[];
            for (const [key, value] of Object.entries(patch)) {
              if (
                value !== null &&
                typeof value === 'object' &&
                'kind' in (value as { kind: string }) &&
                (value as { kind: string }).kind === 'inc'
              ) {
                const inc = value as { col: string; delta: number };
                // Apply SQL-side arithmetic.
                (row as unknown as Record<string, number>)[inc.col] =
                  Number(
                    (row as unknown as Record<string, number>)[inc.col] ?? 0,
                  ) + inc.delta;
              } else {
                (row as unknown as Record<string, unknown>)[key] = value;
              }
            }
            return [row];
          },
        }),
      }),
    }),
    select: (columns?: Record<string, string>) => ({
      // select({...columns}) → project only those columns; select() → *.
      from: (_table: unknown) => ({
        where: (predicate: Pred) => ({
          limit: (_n: number) => {
            const row = hoisted.store.find(predicate);
            if (!row) return [];
            if (!columns) return row ? [row] : [];
            // Project the requested columns.
            const projected: Record<string, unknown> = {};
            for (const [alias, colKey] of Object.entries(columns)) {
              projected[alias] = (row as unknown as Record<string, unknown>)[
                colKey
              ];
            }
            return [projected];
          },
        }),
      }),
    }),
  };
  return { db, schema };
});

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

// The schema is also re-exported by '@/lib/core/db' (mocked above to
// share the same object), but chat.ts imports `schema` from
// '@/lib/core/db'. The standalone '@/lib/core/db/schema' mock is kept
// for any helper that imports it directly.
vi.mock('@/lib/core/db/schema', () => ({
  sessions: {
    id: 'id',
    goalText: 'goalText',
    goalSetAt: 'goalSetAt',
    hiddenContinuationCount: 'hiddenContinuationCount',
    consecutiveNonProgress: 'consecutiveNonProgress',
    lastEvalReason: 'lastEvalReason',
  },
}));

// Import AFTER mocks are registered.
import {
  clearSessionGoal,
  getSessionGoalState,
  incrementGoalCounters,
  setSessionGoal,
} from './chat';

describe('Session Goal DAL', () => {
  beforeEach(() => {
    hoisted.reset();
    hoisted.seed({ id: SESSION_ID });
  });

  describe('setSessionGoal', () => {
    it('writes goal_text + goal_set_at and resets all counters', async () => {
      // Seed a session that already has a goal + non-zero counters from a
      // prior objective. A new goal must zero everything.
      hoisted.reset();
      hoisted.seed({
        id: SESSION_ID,
        goalText: 'old goal',
        goalSetAt: new Date('2024-01-01'),
        hiddenContinuationCount: 5,
        consecutiveNonProgress: 2,
        lastEvalReason: 'stuck',
      });

      const updated = await setSessionGoal(SESSION_ID, 'build a todo app');
      expect(updated).not.toBeNull();
      expect(updated?.goalText).toBe('build a todo app');
      expect(updated?.goalSetAt).toBeInstanceOf(Date);
      // New goal = fresh counters.
      expect(updated?.hiddenContinuationCount).toBe(0);
      expect(updated?.consecutiveNonProgress).toBe(0);
      expect(updated?.lastEvalReason).toBeNull();
    });

    it('returns null for an unknown session id', async () => {
      const result = await setSessionGoal('does-not-exist', 'x');
      expect(result).toBeNull();
    });
  });

  describe('clearSessionGoal', () => {
    it('nulls the goal fields and zeroes the counters', async () => {
      hoisted.reset();
      hoisted.seed({
        id: SESSION_ID,
        goalText: 'some goal',
        goalSetAt: new Date('2024-01-01'),
        hiddenContinuationCount: 3,
        consecutiveNonProgress: 1,
        lastEvalReason: 'almost there',
      });

      const updated = await clearSessionGoal(SESSION_ID);
      expect(updated).not.toBeNull();
      expect(updated?.goalText).toBeNull();
      expect(updated?.goalSetAt).toBeNull();
      expect(updated?.hiddenContinuationCount).toBe(0);
      expect(updated?.consecutiveNonProgress).toBe(0);
      expect(updated?.lastEvalReason).toBeNull();
    });

    it('is idempotent on a session with no goal', async () => {
      const updated = await clearSessionGoal(SESSION_ID);
      expect(updated).not.toBeNull();
      expect(updated?.goalText).toBeNull();
      expect(updated?.hiddenContinuationCount).toBe(0);
    });
  });

  describe('incrementGoalCounters', () => {
    it('atomically increments both counters via SQL-side arithmetic', async () => {
      const before = await getSessionGoalState(SESSION_ID);
      expect(before.hiddenCount).toBe(0);

      await incrementGoalCounters(SESSION_ID, {
        hiddenDelta: 1,
        nonProgressDelta: 1,
        lastEvalReason: 'not done yet',
      });

      const after = await getSessionGoalState(SESSION_ID);
      expect(after.hiddenCount).toBe(1);
      expect(after.consecutiveNonProgress).toBe(1);
      expect(after.lastEvalReason).toBe('not done yet');
    });

    it('accumulates across multiple calls (no read-modify-write loss)', async () => {
      await incrementGoalCounters(SESSION_ID, { hiddenDelta: 1 });
      await incrementGoalCounters(SESSION_ID, { hiddenDelta: 1 });
      await incrementGoalCounters(SESSION_ID, { hiddenDelta: 1 });

      const state = await getSessionGoalState(SESSION_ID);
      expect(state.hiddenCount).toBe(3);
    });

    it('leaves untouched counters unchanged when their delta is omitted/zero', async () => {
      await incrementGoalCounters(SESSION_ID, {
        hiddenDelta: 2,
        lastEvalReason: 'progressing',
      });
      const state = await getSessionGoalState(SESSION_ID);
      expect(state.hiddenCount).toBe(2);
      // nonProgressDelta omitted → column unchanged (still 0).
      expect(state.consecutiveNonProgress).toBe(0);
      expect(state.lastEvalReason).toBe('progressing');
    });

    it('can overwrite lastEvalReason with null to clear it', async () => {
      await incrementGoalCounters(SESSION_ID, {
        lastEvalReason: 'first reason',
      });
      await incrementGoalCounters(SESSION_ID, { lastEvalReason: null });
      const state = await getSessionGoalState(SESSION_ID);
      expect(state.lastEvalReason).toBeNull();
    });

    it('resetNonProgress writes an absolute 0 when the eval reason changes', async () => {
      // Build up a streak of identical non-progress evaluations.
      await incrementGoalCounters(SESSION_ID, {
        nonProgressDelta: 1,
        lastEvalReason: 'stuck on step 3',
      });
      await incrementGoalCounters(SESSION_ID, {
        nonProgressDelta: 1,
        lastEvalReason: 'stuck on step 3',
      });
      let state = await getSessionGoalState(SESSION_ID);
      expect(state.consecutiveNonProgress).toBe(2);

      // The eval reason changed → the streak resets to 0 (a 0 delta
      // would be a truthy-skip and leave the streak at 2).
      await incrementGoalCounters(SESSION_ID, {
        resetNonProgress: true,
        lastEvalReason: 'made progress on step 4',
      });
      state = await getSessionGoalState(SESSION_ID);
      expect(state.consecutiveNonProgress).toBe(0);
      expect(state.lastEvalReason).toBe('made progress on step 4');
    });

    it('resetNonProgress takes precedence over nonProgressDelta', async () => {
      await incrementGoalCounters(SESSION_ID, { nonProgressDelta: 1 });
      await incrementGoalCounters(SESSION_ID, {
        resetNonProgress: true,
        nonProgressDelta: 1,
      });
      const state = await getSessionGoalState(SESSION_ID);
      expect(state.consecutiveNonProgress).toBe(0);
    });
  });

  describe('getSessionGoalState', () => {
    it('returns all-zero/null state for a missing session', async () => {
      const state = await getSessionGoalState('unknown-id');
      expect(state).toEqual({
        goalText: null,
        hiddenCount: 0,
        consecutiveNonProgress: 0,
        lastEvalReason: null,
      });
    });

    it('reads the persisted counters verbatim', async () => {
      hoisted.reset();
      hoisted.seed({
        id: SESSION_ID,
        goalText: 'ship it',
        hiddenContinuationCount: 7,
        consecutiveNonProgress: 2,
        lastEvalReason: 'on the edge',
      });
      const state = await getSessionGoalState(SESSION_ID);
      expect(state.goalText).toBe('ship it');
      expect(state.hiddenCount).toBe(7);
      expect(state.consecutiveNonProgress).toBe(2);
      expect(state.lastEvalReason).toBe('on the edge');
    });
  });
});
