/**
 * Tests for the heartbeat DAL (recordHeartbeatResult auto-disable path).
 *
 * The DB layer is emulated with an in-memory store (same pattern as
 * chat-goal.test.ts): drizzle-orm operators become predicate fns and the
 * `db` mock consumes them directly. The SQL-side increment template
 * (`failureCount + 1`) and the reset template (`0`) are interpreted by
 * the `sql` mock so real arithmetic runs against the store.
 *
 * The key regression test is the auto-disable race: `recordHeartbeatResult`
 * decides to disable from a PRE-disable snapshot, but the disable UPDATE
 * must re-check failureCount in its WHERE clause — a concurrent success
 * that reset the counter between the two statements must win, keeping the
 * heartbeat enabled.
 *
 * Run via: yarn test lib/core/db/heartbeat.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockHeartbeatRow {
  sessionId: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  failureCount: number;
  lastDecisionAt: Date | null;
  lastDecisionReply: boolean | null;
  lastChatRunId: string | null;
  heartbeatWorkflowRunId: string | null;
}

const SESSION_ID = 'sess-heartbeat-1';

// Hoisted state — visible inside vi.mock factories.
const hoisted = vi.hoisted(() => {
  const store: MockHeartbeatRow[] = [];
  return {
    store,
    warnCalls: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
    /** When true, the NEXT increment update simulates a concurrent
     *  success landing between the increment and the auto-disable
     *  recheck: the store row is reset to failureCount = 0 while the
     *  caller still holds the stale pre-reset snapshot. */
    raceResetAfterIncrement: false,
    reset: () => {
      store.length = 0;
      hoisted.warnCalls.length = 0;
      hoisted.raceResetAfterIncrement = false;
    },
    seed: (row: Partial<MockHeartbeatRow> & { sessionId: string }) => {
      const full: MockHeartbeatRow = {
        enabled: true,
        intervalMinutes: 30,
        nextRunAt: null,
        lastRunAt: null,
        failureCount: 0,
        lastDecisionAt: null,
        lastDecisionReply: null,
        lastChatRunId: null,
        heartbeatWorkflowRunId: null,
        ...row,
      };
      store.push(full);
      return full;
    },
  };
});

type Pred = (row: MockHeartbeatRow) => boolean;

vi.mock('drizzle-orm', () => {
  const eq =
    (col: keyof MockHeartbeatRow, value: unknown): Pred =>
    (row) =>
      row[col] === value;
  const gte =
    (col: keyof MockHeartbeatRow, value: number): Pred =>
    (row) =>
      Number(row[col]) >= value;
  const and =
    (...preds: Pred[]): Pred =>
    (row) =>
      preds.every((p) => p(row));
  const isNull =
    (col: keyof MockHeartbeatRow): Pred =>
    (row) =>
      row[col] === null;
  const isNotNull =
    (col: keyof MockHeartbeatRow): Pred =>
    (row) =>
      row[col] !== null;
  const lte =
    (col: keyof MockHeartbeatRow, value: unknown): Pred =>
    (row) =>
      // Unused by the tested paths — present only to satisfy the module's
      // top-level imports; operands are compared loosely.
      (row[col] as unknown as number) <= (value as number);
  // `sql` template tag. Two shapes are written by the DAL:
  // - sql`${col} + 1` → increment descriptor (the delta is literal
  //   template text, not an interpolation — values has length 1);
  // - sql`0`          → constant reset value (no interpolations).
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values.length === 0) {
      return Number(strings.join('').trim());
    }
    const delta =
      values.length > 1
        ? (values[1] as number)
        : Number(
            strings
              .slice(1)
              .join('')
              .replace(/[^-\d]/g, ''),
          );
    return {
      kind: 'inc' as const,
      col: values[0] as keyof MockHeartbeatRow,
      delta,
    };
  };
  return { and, eq, gte, isNull, isNotNull, lte, sql };
});

vi.mock('@/lib/core/db', () => {
  const schema = {
    sessionHeartbeats: {
      sessionId: 'sessionId',
      enabled: 'enabled',
      intervalMinutes: 'intervalMinutes',
      nextRunAt: 'nextRunAt',
      lastRunAt: 'lastRunAt',
      failureCount: 'failureCount',
      lastDecisionAt: 'lastDecisionAt',
      lastDecisionReply: 'lastDecisionReply',
      lastChatRunId: 'lastChatRunId',
      heartbeatWorkflowRunId: 'heartbeatWorkflowRunId',
    },
  };
  const applyPatch = (
    row: MockHeartbeatRow,
    patch: Record<string, unknown>,
  ) => {
    let incApplied = false;
    for (const [key, value] of Object.entries(patch)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        'kind' in (value as { kind: string }) &&
        (value as { kind: string }).kind === 'inc'
      ) {
        const inc = value as { col: keyof MockHeartbeatRow; delta: number };
        (row as unknown as Record<string, number>)[inc.col] =
          Number(row[inc.col] ?? 0) + inc.delta;
        incApplied = true;
      } else {
        (row as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return incApplied;
  };
  const executeUpdate = (predicate: Pred, patch: Record<string, unknown>) => {
    const row = hoisted.store.find(predicate);
    if (!row) return null;
    const incApplied = applyPatch(row, patch);
    // Snapshot taken AFTER the patch but BEFORE any simulated race
    // mutation — this is what the caller sees (the stale pre-disable
    // snapshot in the auto-disable path).
    const snapshot = { ...row };
    if (incApplied && hoisted.raceResetAfterIncrement) {
      row.failureCount = 0;
      hoisted.raceResetAfterIncrement = false;
    }
    return snapshot;
  };
  const db = {
    // The patch is applied eagerly at where() time — the real query
    // executes even without a trailing .returning() (disableSession-
    // Heartbeat relies on that), and .returning() only formats the
    // already-computed snapshot (no double-apply of increments).
    update: (_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: Pred) => {
          const snapshot = executeUpdate(predicate, patch);
          return {
            returning: async (projection?: Record<string, string>) => {
              if (!snapshot) return [];
              if (projection) {
                const projected: Record<string, unknown> = {};
                for (const [alias, colKey] of Object.entries(projection)) {
                  projected[alias] = (
                    snapshot as unknown as Record<string, unknown>
                  )[colKey];
                }
                return [projected];
              }
              return [snapshot];
            },
          };
        },
      }),
    }),
    select: () => ({
      from: (_table: unknown) => ({
        where: (predicate: Pred) => ({
          limit: (_n: number) => {
            const row = hoisted.store.find(predicate);
            return row ? [row] : [];
          },
        }),
      }),
    }),
  };
  return { db, schema };
});

vi.mock('@/lib/utils/logger', () => ({
  createLogger: (_ns: string) => ({
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: (msg: string, ctx: Record<string, unknown>) => {
      hoisted.warnCalls.push({ msg, ctx });
    },
  }),
}));

// Import AFTER mocks are registered.
import {
  MAX_HEARTBEAT_FAILURES,
  disableSessionHeartbeat,
  recordHeartbeatResult,
} from '@/lib/core/db/heartbeat';

describe('recordHeartbeatResult', () => {
  beforeEach(() => {
    hoisted.reset();
  });

  it('increments failureCount on a failed outcome without disabling below MAX', async () => {
    const seeded = hoisted.seed({ sessionId: SESSION_ID, failureCount: 0 });

    const row = await recordHeartbeatResult({
      sessionId: SESSION_ID,
      reply: false,
      failed: true,
    });

    expect(row?.failureCount).toBe(1);
    expect(seeded.enabled).toBe(true);
    expect(seeded.failureCount).toBe(1);
    expect(hoisted.warnCalls).toEqual([]);
  });

  it('resets failureCount to 0 on a successful outcome', async () => {
    const seeded = hoisted.seed({ sessionId: SESSION_ID, failureCount: 2 });

    const row = await recordHeartbeatResult({
      sessionId: SESSION_ID,
      reply: true,
    });

    expect(row?.failureCount).toBe(0);
    expect(seeded.failureCount).toBe(0);
    expect(seeded.enabled).toBe(true);
  });

  it('auto-disables when failureCount reaches MAX_HEARTBEAT_FAILURES', async () => {
    const seeded = hoisted.seed({
      sessionId: SESSION_ID,
      failureCount: MAX_HEARTBEAT_FAILURES - 1,
      nextRunAt: new Date(),
    });

    const row = await recordHeartbeatResult({
      sessionId: SESSION_ID,
      reply: false,
      failed: true,
    });

    expect(row?.failureCount).toBe(MAX_HEARTBEAT_FAILURES);
    // Returned row is the PRE-disable snapshot: enabled still true there.
    expect(row?.enabled).toBe(true);
    // ...but the store row is disabled and de-scheduled.
    expect(seeded.enabled).toBe(false);
    expect(seeded.nextRunAt).toBeNull();
    expect(hoisted.warnCalls).toEqual([
      {
        msg: 'auto_disabled',
        ctx: { sessionId: SESSION_ID, failureCount: MAX_HEARTBEAT_FAILURES },
      },
    ]);
  });

  it('does not disable when a concurrent success reset the counter (stale snapshot race)', async () => {
    // Simulate the exact race the conditional WHERE guards against: this
    // call's increment lands at MAX (stale snapshot says "disable"), but a
    // concurrent success outcome resets failureCount to 0 between the
    // increment and the auto-disable recheck. The disable UPDATE must not
    // match, keeping the heartbeat enabled.
    const seeded = hoisted.seed({
      sessionId: SESSION_ID,
      failureCount: MAX_HEARTBEAT_FAILURES - 1,
    });
    hoisted.raceResetAfterIncrement = true;

    const row = await recordHeartbeatResult({
      sessionId: SESSION_ID,
      reply: false,
      failed: true,
    });

    // Caller still observed the pre-reset incremented snapshot…
    expect(row?.failureCount).toBe(MAX_HEARTBEAT_FAILURES);
    // …but the heartbeat stays enabled: the racing success won.
    expect(seeded.enabled).toBe(true);
    expect(seeded.failureCount).toBe(0);
    expect(hoisted.warnCalls).toEqual([]);
  });

  it('is a no-op for an unknown session row', async () => {
    const row = await recordHeartbeatResult({
      sessionId: 'sess-missing',
      reply: false,
      failed: true,
    });

    expect(row).toBeNull();
    expect(hoisted.warnCalls).toEqual([]);
  });
});

describe('disableSessionHeartbeat', () => {
  beforeEach(() => {
    hoisted.reset();
  });

  it('disables and de-schedules unconditionally (manual/explicit path)', async () => {
    const seeded = hoisted.seed({
      sessionId: SESSION_ID,
      enabled: true,
      nextRunAt: new Date(),
      failureCount: 0,
    });

    await disableSessionHeartbeat(SESSION_ID);

    expect(seeded.enabled).toBe(false);
    expect(seeded.nextRunAt).toBeNull();
    expect(seeded.failureCount).toBe(0);
  });
});
