/**
 * Tests for the BarrierRegistry.
 *
 * Stage A of the multi-agent collaboration design. The registry's
 * release-condition logic is intricate (4 modes, fail-fast paths,
 * quorum-unreachable detection), and the DB layer is mocked via
 * dynamic-import stubs (same pattern as l2-decision-queue.test.ts).
 *
 * Run via: yarn test lib/workflow/agent/barrier.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarrierRegistry, type BarrierSnapshot } from './barrier';

// ── DB layer mock ──────────────────────────────────────────────────
//
// The registry does all DB work via dynamic `await import('@/lib/core/db/agent-barriers')`,
// so mocking that module path is enough — the in-memory store below
// emulates the unique-index dedup and the status='open' guard.

interface MockBarrierRow {
  barrierId: string;
  sessionId?: string;
  runId?: string;
  expected: number;
  released: number;
  mode: string;
  quorum?: number;
  status: string;
  result: Record<string, unknown> | null;
  createdAt: Date;
  releasedAt?: Date;
  expiresAt?: Date;
}

interface MockReleaseRow {
  barrierStableId: string;
  participantId: string;
  ok: boolean;
  payload: unknown;
  releasedAt: Date;
}

const store = {
  barriers: new Map<string, MockBarrierRow>(),
  releases: new Map<string, MockReleaseRow[]>(),
};

function resetStore() {
  store.barriers.clear();
  store.releases.clear();
}

vi.mock('@/lib/core/db/agent-barriers', () => ({
  createBarrier: vi.fn(async (input: Record<string, unknown>) => {
    const row: MockBarrierRow = {
      barrierId: input.barrierId as string,
      sessionId: input.sessionId as string | undefined,
      runId: input.runId as string | undefined,
      expected: input.expected as number,
      released: 0,
      mode: (input.mode as string) ?? 'all',
      quorum: input.quorum as number | undefined,
      status: 'open',
      result: null,
      createdAt: new Date(),
      expiresAt: input.expiresAt as Date | undefined,
    };
    store.barriers.set(row.barrierId, row);
    store.releases.set(row.barrierId, []);
    return row;
  }),
  getBarrier: vi.fn(async (id: string) => store.barriers.get(id) ?? null),
  listBarrierReleases: vi.fn(
    async (id: string) => store.releases.get(id) ?? [],
  ),
  releaseBarrier: vi.fn(
    async (input: {
      barrierStableId: string;
      participantId: string;
      ok: boolean;
      payload?: unknown;
    }) => {
      const row = store.barriers.get(input.barrierStableId);
      if (!row) return { accepted: false, barrier: null, releases: [] };
      if (row.status !== 'open') {
        return { accepted: false, barrier: row, releases: [] };
      }
      const rels = store.releases.get(input.barrierStableId) ?? [];
      // Unique index: (barrierStableId, participantId)
      if (rels.some((r) => r.participantId === input.participantId)) {
        return { accepted: false, barrier: row, releases: [] };
      }
      const release: MockReleaseRow = {
        barrierStableId: input.barrierStableId,
        participantId: input.participantId,
        ok: input.ok,
        payload: input.payload,
        releasedAt: new Date(),
      };
      rels.push(release);
      store.releases.set(input.barrierStableId, rels);
      row.released += 1;
      return {
        accepted: true,
        barrier: row,
        releases: [release as unknown as MockReleaseRow],
      };
    },
  ),
  markBarrierTerminal: vi.fn(
    async (input: {
      barrierStableId: string;
      status: string;
      result: Record<string, unknown>;
    }) => {
      const row = store.barriers.get(input.barrierStableId);
      if (row?.status !== 'open') return null;
      row.status = input.status;
      row.result = input.result;
      row.releasedAt = new Date();
      return row;
    },
  ),
  expireStaleBarriers: vi.fn(async () => []),
  loadOpenBarriers: vi.fn(async () => ({ barriers: [], releases: [] })),
}));
vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

// ── Test helpers ───────────────────────────────────────────────────

function expectReleased(snapshot: BarrierSnapshot | null) {
  expect(snapshot).not.toBeNull();
  expect(snapshot?.status).toBe('released');
}

function expectOpen(snapshot: BarrierSnapshot | null) {
  expect(snapshot).not.toBeNull();
  expect(snapshot?.status).toBe('open');
}

// ── Tests ──────────────────────────────────────────────────────────

describe('BarrierRegistry', () => {
  let registry: BarrierRegistry;

  beforeEach(() => {
    resetStore();
    registry = new BarrierRegistry(60_000); // 1 min default for fast tests
  });

  afterEach(() => {
    registry.stop();
  });

  describe('mode: all', () => {
    it('releases after every expected participant calls release', async () => {
      const id = await registry.create({ expected: 3 });
      expectOpen(registry.peek(id));

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      expectOpen(registry.peek(id));

      await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: true,
      });
      expectOpen(registry.peek(id));

      const snap = await registry.release({
        barrierId: id,
        participantId: 'c',
        ok: true,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(true);
      expect(snap?.reason).toBe('all_released');
    });

    it('marks ok=false when any release fails', async () => {
      const id = await registry.create({ expected: 2 });
      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      const snap = await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: false,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(false);
      expect(snap?.reason).toBe('partial_failure');
    });

    it('ignores duplicate participant releases', async () => {
      const id = await registry.create({ expected: 2 });
      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      // Duplicate participant — should be a no-op.
      const dup = await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      expect(dup?.released).toBe(1);
      expectOpen(dup);

      await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: true,
      });
      expect(registry.peek(id)?.status).toBe('released');
    });
  });

  describe('mode: quorum', () => {
    it('releases once ok-releases reach the quorum threshold', async () => {
      const id = await registry.create({
        expected: 5,
        mode: 'quorum',
        quorum: 2,
      });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: false,
      });
      expectOpen(registry.peek(id));

      const snap = await registry.release({
        barrierId: id,
        participantId: 'c',
        ok: true,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(true);
      expect(snap?.reason).toBe('quorum_reached');
    });

    it('fails fast when quorum becomes mathematically unreachable', async () => {
      const id = await registry.create({
        expected: 3,
        mode: 'quorum',
        quorum: 2,
      });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: false,
      });
      await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: false,
      });
      // 0 ok + 1 remaining = 1 < 2 quorum — unreachable.
      const snap = registry.peek(id);
      expect(snap?.status).toBe('released');
      expect(snap?.ok).toBe(false);
      expect(snap?.reason).toBe('quorum_unreachable');
    });
  });

  describe('mode: first_ok', () => {
    it('releases as soon as one ok-release arrives', async () => {
      const id = await registry.create({ expected: 3, mode: 'first_ok' });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: false,
      });
      expectOpen(registry.peek(id));

      const snap = await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: true,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(true);
      expect(snap?.reason).toBe('first_ok');
    });

    it('fails when every participant fails', async () => {
      const id = await registry.create({ expected: 2, mode: 'first_ok' });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: false,
      });
      expectOpen(registry.peek(id));

      const snap = await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: false,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(false);
      expect(snap?.reason).toBe('no_ok');
    });
  });

  describe('mode: first_fail', () => {
    it('fails fast on the first failed release', async () => {
      const id = await registry.create({
        expected: 3,
        mode: 'first_fail',
      });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      expectOpen(registry.peek(id));

      const snap = await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: false,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(false);
      expect(snap?.reason).toBe('first_fail');
    });

    it('releases ok when all participants succeed', async () => {
      const id = await registry.create({
        expected: 2,
        mode: 'first_fail',
      });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      const snap = await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: true,
      });
      expectReleased(snap);
      expect(snap?.ok).toBe(true);
      expect(snap?.reason).toBe('all_released');
    });
  });

  describe('waitFor', () => {
    it('blocks until a release fires the barrier', async () => {
      const id = await registry.create({ expected: 1 });

      const waitPromise = registry.waitFor(id);
      // Resolve the barrier a tick later.
      setTimeout(() => {
        void registry.release({
          barrierId: id,
          participantId: 'a',
          ok: true,
        });
      }, 10);

      const snap = await waitPromise;
      expectReleased(snap);
      expect(snap?.ok).toBe(true);
    });

    it('returns immediately if the barrier is already terminal', async () => {
      const id = await registry.create({ expected: 1 });
      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });

      const snap = await registry.waitFor(id);
      expectReleased(snap);
    });

    it('returns null for an unknown barrier', async () => {
      const snap = await registry.waitFor('does-not-exist');
      expect(snap).toBeNull();
    });

    it('supports multiple concurrent waiters on the same barrier', async () => {
      const id = await registry.create({ expected: 1 });

      const w1 = registry.waitFor(id);
      const w2 = registry.waitFor(id);
      const w3 = registry.waitFor(id);

      setTimeout(() => {
        void registry.release({
          barrierId: id,
          participantId: 'a',
          ok: true,
        });
      }, 10);

      const [s1, s2, s3] = await Promise.all([w1, w2, w3]);
      expectReleased(s1);
      expectReleased(s2);
      expectReleased(s3);
    });
  });

  describe('cancel', () => {
    it('flips an open barrier to cancelled and resolves waiters', async () => {
      const id = await registry.create({ expected: 2 });

      const waitPromise = registry.waitFor(id);
      const cancelPromise = registry.cancel({
        barrierId: id,
        reason: 'user_aborted',
      });

      const [snap, cancelSnap] = await Promise.all([
        waitPromise,
        cancelPromise,
      ]);
      expect(snap?.status).toBe('cancelled');
      expect(cancelSnap?.status).toBe('cancelled');
      expect(cancelSnap?.ok).toBe(false);
      expect(cancelSnap?.reason).toBe('user_aborted');
    });

    it('is a no-op on a terminal barrier', async () => {
      const id = await registry.create({ expected: 1 });
      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
      });
      const before = registry.peek(id)?.status;

      const snap = await registry.cancel({ barrierId: id });
      expect(snap?.status).toBe(before);
    });
  });

  describe('lazy DB load', () => {
    it('releases a barrier this process did not create (cross-process)', async () => {
      // Simulate another process having created the barrier by writing
      // directly to the mock store.
      const externalId = 'bar_external_xyz';
      store.barriers.set(externalId, {
        barrierId: externalId,
        expected: 2,
        released: 0,
        mode: 'all',
        status: 'open',
        result: null,
        createdAt: new Date(),
      });
      store.releases.set(externalId, []);

      // This registry has no cache entry — release() must lazy-load.
      const snap = await registry.release({
        barrierId: externalId,
        participantId: 'p1',
        ok: true,
      });
      expect(snap?.released).toBe(1);
      expectOpen(snap);

      const finalSnap = await registry.release({
        barrierId: externalId,
        participantId: 'p2',
        ok: true,
      });
      expectReleased(finalSnap);
    });
  });

  describe('payload aggregation', () => {
    it('surfaces every release payload on the released snapshot', async () => {
      const id = await registry.create({ expected: 3 });

      await registry.release({
        barrierId: id,
        participantId: 'a',
        ok: true,
        payload: { value: 1 },
      });
      await registry.release({
        barrierId: id,
        participantId: 'b',
        ok: true,
        payload: { value: 2 },
      });
      const snap = await registry.release({
        barrierId: id,
        participantId: 'c',
        ok: true,
        payload: { value: 3 },
      });

      expect(snap?.releases).toHaveLength(3);
      expect(snap?.releases.map((r) => r.participantId)).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(snap?.releases.map((r) => r.payload)).toEqual([
        { value: 1 },
        { value: 2 },
        { value: 3 },
      ]);
    });
  });
});
