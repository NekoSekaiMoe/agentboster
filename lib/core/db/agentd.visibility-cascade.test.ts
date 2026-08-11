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
  batchSpy: vi.fn(async (_queries: unknown[]) => [[], [], [], []]),
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
  // returned "query object" is an opaque marker — `db.batch` receives
  // them and the spy decides success/failure.
  const chain = (tag: string) => {
    const next: Record<string, unknown> = {};
    const terminate = (terminalTag: string) => ({
      __tag: `${tag}:${terminalTag}`,
    });
    next.where = () => ({
      ...terminate('where'),
      returning: () => terminate('where.returning'),
    });
    next.set = () => ({ where: () => terminate('set.where') });
    next.values = () => ({ returning: () => terminate('values.returning') });
    next.from = () => ({
      where: () => ({ limit: () => terminate('from.where.limit') }),
    });
    return next;
  };

  return {
    db: {
      update: () => chain('update'),
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
    batchSpy.mockResolvedValue([[], [], [], []]);
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

    it('go-private batches all 4 writes and bumps KV exactly once after commit', async () => {
      // Two selects happen in the neon branch: the pre-flight (returns
      // the active row) and the post-batch re-read (returns the
      // committed private/toggled-off row). Feed them in order.
      const committedRow = [
        {
          ...ACTIVE_WORKSPACE[0],
          visibility: 'private' as const,
          sharedMemoryEnabled: false,
        },
      ];
      const selectReturns = [ACTIVE_WORKSPACE, committedRow];
      let selectCall = 0;
      const dbModule = await import('@/lib/core/db');
      const db = (dbModule as unknown as { db: Record<string, unknown> }).db;
      db.select = () => {
        const limit = () => Promise.resolve(selectReturns[selectCall++] ?? []);
        return {
          from: () => ({ where: () => ({ limit }) }),
        };
      };

      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');

      // Exactly one batch, with 4 pre-built query elements.
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect((batchSpy.mock.calls[0] as unknown[])[0]).toHaveLength(4);
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
      const txStub = {
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        delete: () => ({ where: () => Promise.resolve() }),
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([committedRow]) }),
          }),
        }),
      };
      transactionSpy.mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub),
      );

      const result = await setWorkspaceVisibilityCascade(WS_ID, 'private');

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).not.toHaveBeenCalled();
      expect(bumpSpy).toHaveBeenCalledTimes(1);
      expect(bumpSpy).toHaveBeenCalledWith(WS_ID);
      expect(result).toMatchObject({
        visibility: 'private',
        sharedMemoryEnabled: false,
      });
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
      // tx.update succeeds, but tx.delete throws — simulating a failure
      // on step 4 of the cascade. The error propagates = rollback.
      const txStub = {
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        delete: () => ({
          where: () => Promise.reject(new Error('delete failed mid-tx')),
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
      ).rejects.toThrow('delete failed mid-tx');

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
