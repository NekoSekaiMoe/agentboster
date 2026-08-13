/**
 * Atomic-cascade test for `setWorkspaceVisibilityCascade` — covers the
 * things PGlite (lib/core/db/agentd.workspaces.test.ts) structurally
 * cannot:
 *
 *   - The NEON `db.batch([...])` branch (PGlite's `atomicWriteMode()`
 *     resolves to 'postgres', so the batch path is unreachable there).
 *   - Mid-cascade failure → full rollback on BOTH branches (forcing a
 *     real DB error mid-transaction against PGlite would mean dropping
 *     tables, which poisons sibling tests via the shared resetDb list).
 *   - The shared-memory KV version bump fires EXACTLY ONCE and ONLY
 *     AFTER the DB block commits — never when it throws.
 *
 * The db handle is a hand-rolled chainable stub; `db.batch` and
 * `db.transaction` are spies so we can both inject failure and assert
 * call order. `atomicWriteMode`'s branch is steered by stubbing
 * `resolveDriver` on the mocked `@/lib/core/db` surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { batchSpy, transactionSpy, bumpSpy, resolveDriver } = vi.hoisted(() => ({
  // neon primitive — receives the pre-built query objects, returns an
  // array of result-arrays (one per batch element). Default: succeed.
  // Element type is loosened to `unknown[]` so tests can seed RETURNING
  // rows (e.g. `[{ id: 'mem-1' }]`) without TS narrowing the inferred
  // tuple to `never[][]`.
  batchSpy: vi.fn(
    async (_queries: unknown[]) => [[], [], [], [], [], []] as unknown[][],
  ),
  // pg primitive — receives an interactive callback. Default: run it.
  transactionSpy: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({}),
  ),
  bumpSpy: vi.fn(async (_workspaceId: string) => 1),
  // Which branch `atomicWriteMode()` picks. Tests flip this.
  resolveDriver: { current: 'neon' as 'neon' | 'postgres' },
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/memory/shared-version', () => ({
  bumpSharedMemoryVersion: bumpSpy,
}));

vi.mock('@/lib/core/db', () => {
  // Every chainable builder returns an object that also satisfies the
  // `.returning()` / `.where()` terminators the cascade pre-builds. The
  // returned "query object" carries `__tag` (chain shape) and `__table`
  // (the table argument passed to db.update) so tests can assert WHICH
  // table each batch element targets — required to pin the ordering
  // invariant (session_memories stamp before sessions reset), which a
  // table-agnostic stub structurally cannot detect.
  const chain = (tag: string, table?: unknown) => {
    const next: Record<string, unknown> = {};
    const terminate = (terminalTag: string) => ({
      __tag: `${tag}:${terminalTag}`,
      __table: table,
    });
    next.where = () => ({
      ...terminate('where'),
      returning: () => terminate('where.returning'),
    });
    next.set = () => ({
      where: () => ({
        ...terminate('set.where'),
        returning: () => terminate('set.where.returning'),
      }),
    });
    next.values = () => ({ returning: () => terminate('values.returning') });
    next.from = () => ({
      where: () => ({ limit: () => terminate('from.where.limit') }),
    });
    return next;
  };

  return {
    db: {
      update: (table?: unknown) => chain('update', table),
      delete: () => chain('delete'),
      insert: () => chain('insert'),
      select: () => chain('select'),
      // Pre-flight read + post-batch re-read. Returns an array whose
      // first element carries the row shape the cascade inspects.
      // `select().from().where().limit()` resolves to the marker above,
      // so we can't easily thread row data through it — instead the
      // cascade's select is a separate concern: the pre-flight uses the
      // same chain. To keep this simple we make `select` return a thenable
      // array directly via a dedicated path below.
      batch: batchSpy,
      transaction: transactionSpy,
    },
  };
});

// The cascade resolves the driver via `resolveDriver` re-exported from
// `@/lib/core/db` (mocked above does NOT include it). Instead of coupling
// to that re-export, we mock `./atomic` — the actual module
// `atomicWriteMode` lives in — so the branch is deterministic per test.
vi.mock('@/lib/core/db/atomic', () => ({
  atomicWriteMode: () => resolveDriver.current,
}));

import { setWorkspaceVisibilityCascade } from './agentd';
import {
  longTermMemories,
  sessionMemories,
  sessions,
  workspaces,
} from './schema';

type BatchElement = { __tag: string; __table?: unknown };

/** Build a tx stub whose `update` records the target table of each
 *  UPDATE in execution order (so tests can assert the session_memories
 *  stamp lands before the sessions reset) and whose `.returning()`
 *  resolves `returningRows` ONLY for the long_term_memories shared-pool
 *  quarantine (the one place the cascade reads RETURNING; everything
 *  else is fire-and-forget). */
function makeOrderTrackingTxStub(opts: {
  updateOrder: string[];
  quarantinedIds: { id: string }[];
  committedRow: unknown;
}) {
  const tagFor = (table: unknown) =>
    table === sessionMemories
      ? 'session_memories.stamp'
      : table === sessions
        ? 'sessions.reset'
        : table === longTermMemories
          ? 'long_term.quarantine'
          : table === workspaces
            ? 'workspaces'
            : 'unknown';
  return {
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          opts.updateOrder.push(tagFor(table));
          return {
            returning: () =>
              Promise.resolve(
                table === longTermMemories ? opts.quarantinedIds : [],
              ),
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([opts.committedRow]),
        }),
      }),
    }),
  };
}

const WS_ID = 'ws-1';
const ACTIVE_WORKSPACE = [
  {
    id: WS_ID,
    ownerId: 'u1',
    name: 'w',
    preferredNodeId: null,
    nodeGeneration: 1,
    isDefault: false,
    visibility: 'public',
    sharedMemoryEnabled: true,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

/**
 * The cascade's pre-flight `db.select(...).from(...).where(...).limit()`
 * chain resolves to an opaque marker object under our mock — the cascade
 * then reads `[0]` off the limit() result. To feed it a real row we
 * override `db.select` per-test so the chain bottoms out at a thenable
 * array. This helper installs that override on the mocked db module.
 */
async function installSelectRow(row: unknown[] | undefined) {
  const dbModule = await import('@/lib/core/db');
  const db = (dbModule as unknown as { db: Record<string, unknown> }).db;
  db.select = () => {
    const limit = () => Promise.resolve(row ?? []);
    return {
      from: () => ({ where: () => ({ limit }) }),
    };
  };
}

describe('setWorkspaceVisibilityCascade — atomic branches', () => {
  beforeEach(() => {
    batchSpy.mockClear();
    batchSpy.mockResolvedValue([[], [], [], [], [], []]);
    transactionSpy.mockClear();
    transactionSpy.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
    );
    bumpSpy.mockClear();
    resolveDriver.current = 'neon';
  });

  describe('neon branch (db.batch)', () => {
    beforeEach(() => {
      resolveDriver.current = 'neon';
    });

    it('go-private batches all 6 writes and bumps KV exactly once after commit', async () => {
      // Three selects happen in the neon branch on the go-private path:
      //   1. pre-flight archived check (returns the active row)
      //   2. quarantine-epoch read (returns the row with quarantineEpoch)
      //   3. post-batch re-read (returns the committed private/toggled-off row)
      // Feed them in order.
      const epochRow = [{ ...ACTIVE_WORKSPACE[0], quarantineEpoch: 3 }];
      const committedRow = [
        {
          ...ACTIVE_WORKSPACE[0],
          visibility: 'private' as const,
          sharedMemoryEnabled: false,
        },
      ];
      const selectReturns = [ACTIVE_WORKSPACE, epochRow, committedRow];
      let selectCall = 0;
      const dbModule = await import('@/lib/core/db');
      const db = (dbModule as unknown as { db: Record<string, unknown> }).db;
      db.select = () => {
        const limit = () => Promise.resolve(selectReturns[selectCall++] ?? []);
        return {
          from: () => ({ where: () => ({ limit }) }),
        };
      };
      // The batch's last element (index 5) is the shared-pool QUARANTINE
      // UPDATE's RETURNING — a non-empty array means rows were flipped
      // to dream_status='quarantined', which gates the KV version bump.
      // Seed one quarantined-id so the bump fires once.
      batchSpy.mockResolvedValueOnce([[], [], [], [], [], [{ id: 'mem-1' }]]);

      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');

      // Exactly one batch, with 6 pre-built query elements.
      expect(batchSpy).toHaveBeenCalledTimes(1);
      const elements = (
        batchSpy.mock.calls[0] as unknown[]
      )[0] as BatchElement[];
      expect(elements).toHaveLength(6);
      // ORDERING INVARIANT (regression): the session_memories quarantine
      // stamp (index 3) MUST precede the sessions visibility reset
      // (index 4) — its WHERE subquery matches sessions by
      // visibility='shared', which the reset flips to 'private'. With the
      // old order the subquery saw the reset's writes (READ COMMITTED,
      // same transaction) and matched 0 rows, so quarantined_at was never
      // written.
      expect(elements[3]?.__table).toBe(sessionMemories);
      expect(elements[4]?.__table).toBe(sessions);
      // The shared-pool quarantine (with RETURNING) is the last element.
      expect(elements[5]?.__table).toBe(longTermMemories);
      // KV bump happened exactly once, AFTER the batch resolved.
      expect(bumpSpy).toHaveBeenCalledTimes(1);
      expect(bumpSpy).toHaveBeenCalledWith(WS_ID);
      // Response reflects the committed (post-cascade) row.
      expect(result).toEqual(committedRow[0]);
    });

    it('does NOT batch and does NOT bump KV for archived rows (pre-flight short-circuits)', async () => {
      await installSelectRow([]); // archived / missing → null
      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');
      expect(result).toBeNull();
      expect(batchSpy).not.toHaveBeenCalled();
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('skips the KV bump when the shared-pool quarantine was a 0-row no-op (e.g. concurrent archive won the race)', async () => {
      // Same shape as the happy path, but the QUARANTINE UPDATE's
      // RETURNING is an empty array — the cascade detected no
      // shared-pool rows to quarantine (concurrent archive landed
      // mid-flight, or there was simply nothing in the pool). The KV
      // version bump must NOT fire.
      const epochRow = [{ ...ACTIVE_WORKSPACE[0], quarantineEpoch: 0 }];
      const committedRow = [
        {
          ...ACTIVE_WORKSPACE[0],
          visibility: 'private' as const,
          sharedMemoryEnabled: false,
        },
      ];
      const selectReturns = [ACTIVE_WORKSPACE, epochRow, committedRow];
      let selectCall = 0;
      const dbModule = await import('@/lib/core/db');
      const db = (dbModule as unknown as { db: Record<string, unknown> }).db;
      db.select = () => {
        const limit = () => Promise.resolve(selectReturns[selectCall++] ?? []);
        return {
          from: () => ({ where: () => ({ limit }) }),
        };
      };
      batchSpy.mockResolvedValueOnce([[], [], [], [], [], []]);

      await setWorkspaceVisibilityCascade(WS_ID, 'private');

      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('rolls back (propagates the error) and skips the KV bump when batch throws', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      batchSpy.mockRejectedValueOnce(new Error('neon batch aborted'));

      await expect(
        setWorkspaceVisibilityCascade(WS_ID, 'private'),
      ).rejects.toThrow('neon batch aborted');

      // The atomic block failed → the post-commit KV bump MUST NOT fire.
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('go-public skips the batch entirely (single-column update) and does not bump KV', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      // Public direction: cascade issues a plain update + returning, no batch.
      // The pre-built chain returns a marker; override update().set().where().returning().
      const dbModule = await import('@/lib/core/db');
      const db = (dbModule as unknown as { db: Record<string, unknown> }).db;
      db.update = () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve([
                { ...ACTIVE_WORKSPACE[0], visibility: 'public' },
              ]),
          }),
        }),
      });

      const result = await setWorkspaceVisibilityCascade(WS_ID, 'public');

      expect(batchSpy).not.toHaveBeenCalled();
      expect(transactionSpy).not.toHaveBeenCalled();
      expect(bumpSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ visibility: 'public' });
    });
  });

  describe('postgres branch (db.transaction)', () => {
    beforeEach(() => {
      resolveDriver.current = 'postgres';
    });

    it('go-private runs the writes inside a transaction and bumps KV once after commit', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      // The tx callback does its own select().from().where().limit() to
      // produce the returned row — wire `tx` with a select chain.
      const committedRow = {
        ...ACTIVE_WORKSPACE[0],
        visibility: 'private',
        sharedMemoryEnabled: false,
      };
      // The tx stub distinguishes each UPDATE by its target table and
      // records execution order. Seed one quarantined-id from the
      // shared-pool quarantine's RETURNING so the KV bump fires once.
      const updateOrder: string[] = [];
      const txStub = makeOrderTrackingTxStub({
        updateOrder,
        quarantinedIds: [{ id: 'mem-1' }],
        committedRow,
      });
      transactionSpy.mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub),
      );

      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
      // ORDERING INVARIANT (regression): the session_memories stamp MUST
      // execute before the sessions visibility reset inside the tx — its
      // WHERE subquery matches visibility='shared', which the reset
      // flips. The old order stamped AFTER the reset and the subquery
      // (seeing the tx's own writes) matched 0 rows.
      expect(
        updateOrder.indexOf('session_memories.stamp'),
      ).toBeGreaterThanOrEqual(0);
      expect(updateOrder.indexOf('session_memories.stamp')).toBeLessThan(
        updateOrder.indexOf('sessions.reset'),
      );
      // Sanity: both workspaces UPDATEs and the shared-pool quarantine ran.
      expect(updateOrder.filter((t) => t === 'workspaces')).toHaveLength(2);
      expect(updateOrder).toContain('long_term.quarantine');
      expect(bumpSpy).toHaveBeenCalledTimes(1);
      expect(bumpSpy).toHaveBeenCalledWith(WS_ID);
      expect(result).toMatchObject({
        visibility: 'private',
        sharedMemoryEnabled: false,
      });
    });

    it('0-row shared-pool quarantine: session stamp still precedes the sessions reset and the KV bump is skipped', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      const committedRow = {
        ...ACTIVE_WORKSPACE[0],
        visibility: 'private',
        sharedMemoryEnabled: false,
      };
      // The shared-pool quarantine's RETURNING is empty — nothing in the
      // pool (or a concurrent archive won the race). The session_memories
      // stamp and sessions reset still run, in the required order, and
      // the KV bump must NOT fire.
      const updateOrder: string[] = [];
      const txStub = makeOrderTrackingTxStub({
        updateOrder,
        quarantinedIds: [],
        committedRow,
      });
      transactionSpy.mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub),
      );

      await setWorkspaceVisibilityCascade(WS_ID, 'private');

      expect(updateOrder.indexOf('session_memories.stamp')).toBeLessThan(
        updateOrder.indexOf('sessions.reset'),
      );
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('rolls back (propagates the error) and skips the KV bump when the transaction body throws', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      transactionSpy.mockImplementationOnce(async () => {
        throw new Error('pg transaction rolled back');
      });

      await expect(
        setWorkspaceVisibilityCascade(WS_ID, 'private'),
      ).rejects.toThrow('pg transaction rolled back');

      // KV bump must not run when the DB block failed.
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('rolls back when a statement INSIDE the tx body throws (mid-cascade)', async () => {
      await installSelectRow(ACTIVE_WORKSPACE);
      // tx.update succeeds for the first writes, but the shared-pool
      // quarantine UPDATE (chained .where().returning()) throws —
      // simulating a failure on the quarantine step. The error
      // propagates = rollback.
      let updateCall = 0;
      const txStub = {
        update: () => ({
          set: () => ({
            where: () => {
              updateCall += 1;
              // The cascade issues several tx.update calls; the
              // quarantine one (with .returning()) is the one we want
              // to fail. The first few are fire-and-forget (resolve),
              // the returning() chain rejects.
              return {
                returning: () =>
                  updateCall >= 1
                    ? Promise.reject(
                        new Error('quarantine update failed mid-tx'),
                      )
                    : Promise.resolve(),
              };
            },
          }),
        }),
        select: () => ({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
        }),
      };
      transactionSpy.mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub),
      );

      await expect(
        setWorkspaceVisibilityCascade(WS_ID, 'private'),
      ).rejects.toThrow('quarantine update failed mid-tx');

      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it('returns null for archived rows without opening a transaction', async () => {
      await installSelectRow([]); // archived
      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');
      expect(result).toBeNull();
      expect(transactionSpy).not.toHaveBeenCalled();
      expect(bumpSpy).not.toHaveBeenCalled();
    });
  });
});
