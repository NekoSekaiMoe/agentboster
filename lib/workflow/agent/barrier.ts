/**
 * BarrierRegistry: a durable, DB-backed synchronization primitive for
 * multi-agent collaboration.
 *
 * Stage A of the design: a generic barrier that lets a workflow fan out
 * N participants and block until a release condition is met:
 *   - all         — every expected participant must release (default).
 *   - quorum      — at least `quorum` ok-releases required.
 *   - first_ok    — the first ok-release releases the barrier.
 *   - first_fail  — the first failed release releases the barrier
 *                   (fail-fast semantics for batched work).
 *
 * Architecture mirrors DecisionQueue (lib/security/l2-decision-queue.ts):
 *   - Every create/release/cancel touches BOTH the DB (durable backing
 *     store) and an in-memory cache (for fast condition checks).
 *   - waitForBarrier() registers a Promise resolver in a Map; release()
 *     fires it when the barrier transitions to terminal.
 *   - A watchdog timer expires stale barriers whose expiresAt is past.
 *   - rehydrateFromDb() on boot repopulates the cache so a new Vercel
 *     instance picks up barriers that survived from a prior deploy.
 *
 * Why a registry and not just Promise.all:
 *   - subAgent's sync-batch already uses Promise.all + concurrency limiter
 *     (sub-agent.ts:163), but that approach dies with the parent
 *     workflow process. A registry-backed barrier survives crashes,
 *     can be released by participants in OTHER processes (schedule
 *     tools, separate workflow runs), and can be queried from the UI.
 *
 * Why not use Workflow DevKit's defineHook (like approval/local-tool
 * hooks): those are single-waiter, token-keyed. A barrier is N-party
 * with a release condition; we need our own resolver map.
 */

import { createLogger } from '@/lib/utils/logger';
import type { AgentBarrier, AgentBarrierRelease } from '@/lib/core/db/schema';

const logger = createLogger('workflow.agent.barrier');

export type BarrierMode = 'all' | 'quorum' | 'first_ok' | 'first_fail';

export interface BarrierSnapshot {
  barrierId: string;
  sessionId?: string;
  runId?: string;
  expected: number;
  released: number;
  mode: BarrierMode;
  quorum?: number;
  status: 'open' | 'released' | 'cancelled' | 'expired';
  releases: Array<{
    participantId: string;
    ok: boolean;
    payload?: unknown;
    releasedAt: string;
  }>;
  createdAt: string;
  releasedAt?: string;
  expiresAt?: string;
  reason?: string;
  ok: boolean;
}

export interface CreateBarrierOptions {
  sessionId?: string;
  runId?: string;
  expected: number;
  mode?: BarrierMode;
  quorum?: number;
  /** Absolute deadline. Combined with the watchdog for expiry. */
  expiresAt?: Date;
}

export interface ReleaseBarrierOptions {
  barrierId: string;
  participantId: string;
  ok: boolean;
  payload?: unknown;
}

export interface CancelBarrierOptions {
  barrierId: string;
  reason?: string;
}

interface BarrierWaiter {
  resolve: (snapshot: BarrierSnapshot | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface CachedBarrier {
  barrierId: string;
  sessionId?: string;
  runId?: string;
  expected: number;
  released: number;
  mode: BarrierMode;
  quorum?: number;
  status: 'open' | 'released' | 'cancelled' | 'expired';
  expiresAt?: Date;
  releases: Array<{
    participantId: string;
    ok: boolean;
    payload?: unknown;
    releasedAt: string;
  }>;
  ok: boolean;
  reason?: string;
  createdAt: string;
  releasedAt?: string;
}

const SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function generateBarrierId(): string {
  return `bar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isTerminal(status: CachedBarrier['status']): boolean {
  return status !== 'open';
}

/**
 * Decide whether the current release state satisfies the barrier's
 * condition. Pure function over the cached state; the registry calls
 * it after every release to decide whether to flip to terminal.
 *
 * Returns null when the barrier should stay open; otherwise returns
 * the terminal status to set + the overall `ok` value.
 */
function evaluateCondition(
  cache: CachedBarrier,
): { status: 'released'; ok: boolean; reason?: string } | null {
  if (cache.mode === 'all') {
    if (cache.released >= cache.expected) {
      const anyFail = cache.releases.some((r) => !r.ok);
      return {
        status: 'released',
        ok: !anyFail,
        reason: anyFail ? 'partial_failure' : 'all_released',
      };
    }
    return null;
  }

  if (cache.mode === 'quorum') {
    const okCount = cache.releases.filter((r) => r.ok).length;
    const threshold = cache.quorum ?? cache.expected;
    if (okCount >= threshold) {
      return { status: 'released', ok: true, reason: 'quorum_reached' };
    }
    // Quorum is unreachable if remaining unreleased participants can't
    // make up the deficit — fail fast so waiters don't hang.
    const remaining = cache.expected - cache.released;
    if (okCount + remaining < threshold) {
      return { status: 'released', ok: false, reason: 'quorum_unreachable' };
    }
    return null;
  }

  if (cache.mode === 'first_ok') {
    const firstOk = cache.releases.find((r) => r.ok);
    if (firstOk) {
      return { status: 'released', ok: true, reason: 'first_ok' };
    }
    // first_ok becomes unreachable only when all participants have
    // released with no ok — at that point the barrier is failed.
    if (cache.released >= cache.expected) {
      return { status: 'released', ok: false, reason: 'no_ok' };
    }
    return null;
  }

  if (cache.mode === 'first_fail') {
    const firstFail = cache.releases.find((r) => !r.ok);
    if (firstFail) {
      return { status: 'released', ok: false, reason: 'first_fail' };
    }
    if (cache.released >= cache.expected) {
      return { status: 'released', ok: true, reason: 'all_released' };
    }
    return null;
  }

  return null;
}

function cacheToSnapshot(cache: CachedBarrier): BarrierSnapshot {
  return {
    barrierId: cache.barrierId,
    sessionId: cache.sessionId,
    runId: cache.runId,
    expected: cache.expected,
    released: cache.released,
    mode: cache.mode,
    quorum: cache.quorum,
    status: cache.status,
    releases: cache.releases,
    ok: cache.ok,
    reason: cache.reason,
    createdAt: cache.createdAt,
    releasedAt: cache.releasedAt,
    expiresAt: cache.expiresAt?.toISOString(),
  };
}

function rowToCache(
  row: AgentBarrier,
  releases: AgentBarrierRelease[],
): CachedBarrier {
  return {
    barrierId: row.barrierId,
    sessionId: row.sessionId ?? undefined,
    runId: row.runId ?? undefined,
    expected: row.expected,
    released: row.released,
    mode: (row.mode as BarrierMode) ?? 'all',
    quorum: row.quorum ?? undefined,
    status: (row.status as CachedBarrier['status']) ?? 'open',
    expiresAt: row.expiresAt ?? undefined,
    releases: releases.map((r) => ({
      participantId: r.participantId,
      ok: r.ok,
      payload: r.payload,
      releasedAt: r.releasedAt.toISOString(),
    })),
    ok: row.result?.ok ?? false,
    reason: row.result?.reason,
    createdAt: row.createdAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString(),
  };
}

export class BarrierRegistry {
  private cache = new Map<string, CachedBarrier>();
  private waiters = new Map<string, Set<BarrierWaiter>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
    this.startSweeper();
  }

  stop() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    // Reject every outstanding waiter with an expired snapshot so they
    // don't hang the shutdown.
    for (const [barrierId, set] of this.waiters.entries()) {
      const cache = this.cache.get(barrierId);
      if (!cache) continue;
      const snapshot = cacheToSnapshot({
        ...cache,
        status: 'expired',
        reason: 'shutdown',
      });
      for (const w of set) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve(snapshot);
      }
    }
    this.waiters.clear();
  }

  /**
   * Create a new open barrier and persist it to the DB. Returns the
   * stable barrier id (caller passes it back to release/wait/cancel).
   */
  async create(options: CreateBarrierOptions): Promise<string> {
    const barrierId = generateBarrierId();
    const expiresAt =
      options.expiresAt ?? new Date(Date.now() + this.defaultTimeoutMs);

    // Dynamic import keeps the workflow bundle clean (no top-level
    // drizzle/db dependency at module init).
    const { createBarrier } = await import('@/lib/core/db/agent-barriers');
    const row = await createBarrier({
      barrierId,
      sessionId: options.sessionId,
      runId: options.runId,
      expected: options.expected,
      mode: options.mode ?? 'all',
      quorum: options.quorum,
      expiresAt,
    });

    const cache: CachedBarrier = {
      barrierId,
      sessionId: options.sessionId,
      runId: options.runId,
      expected: options.expected,
      released: 0,
      mode: options.mode ?? 'all',
      quorum: options.quorum,
      status: 'open',
      expiresAt,
      releases: [],
      ok: false,
      createdAt: row.createdAt.toISOString(),
    };
    this.cache.set(barrierId, cache);
    return barrierId;
  }

  /**
   * Idempotent release. Returns the post-release snapshot (always the
   * current state of the barrier, whether or not this call was the one
   * that released it). Fires any in-process waiters when the barrier
   * transitions to terminal.
   */
  async release(
    options: ReleaseBarrierOptions,
  ): Promise<BarrierSnapshot | null> {
    const { barrierId, participantId, ok, payload } = options;

    // Resolve cache first; if missing, lazy-load from DB so a process
    // that doesn't own the barrier can still release it (e.g. schedule
    // tool firing in a different Vercel instance).
    let cache = this.cache.get(barrierId);
    if (!cache) {
      const hydrated = await this.loadFromDb(barrierId);
      if (!hydrated) {
        logger.warn('release: barrier not found', { barrierId, participantId });
        return null;
      }
      cache = hydrated;
    }

    if (isTerminal(cache.status)) {
      logger.info('release: barrier already terminal', {
        barrierId,
        participantId,
        status: cache.status,
      });
      return cacheToSnapshot(cache);
    }

    const { releaseBarrier } = await import('@/lib/core/db/agent-barriers');
    const outcome = await releaseBarrier({
      barrierStableId: barrierId,
      participantId,
      ok,
      payload,
    });

    if (!outcome.accepted || !outcome.barrier) {
      // Duplicate participant — return current snapshot unchanged.
      return cacheToSnapshot(cache);
    }

    // Update cache with the new counter + release row.
    cache.released = outcome.barrier.released;
    cache.releases.push({
      participantId,
      ok,
      payload,
      releasedAt:
        outcome.releases[0]?.releasedAt.toISOString() ??
        new Date().toISOString(),
    });

    // Evaluate the release condition; if met, flip to terminal.
    const verdict = evaluateCondition(cache);
    if (verdict) {
      await this.finalizeBarrier(
        barrierId,
        verdict.status,
        verdict.ok,
        verdict.reason,
      );
    }

    const finalCache = this.cache.get(barrierId);
    return finalCache ? cacheToSnapshot(finalCache) : null;
  }

  /**
   * Block until the barrier reaches a terminal state. Returns the
   * final snapshot (released/cancelled/expired). If the barrier is
   * already terminal in cache or DB, resolves immediately.
   *
   * `timeoutMs` is the in-process wait cap; the DB `expiresAt` is the
   * hard cap that survives process restarts.
   */
  async waitFor(
    barrierId: string,
    timeoutMs?: number,
  ): Promise<BarrierSnapshot | null> {
    let cache = this.cache.get(barrierId);
    if (!cache) {
      const hydrated = await this.loadFromDb(barrierId);
      if (!hydrated) return null;
      cache = hydrated;
    }

    if (isTerminal(cache.status)) {
      return cacheToSnapshot(cache);
    }

    // Register a waiter. Multiple waiters per barrier are allowed
    // (e.g. a parent workflow that spawns the barrier plus a UI poll).
    return new Promise<BarrierSnapshot | null>((resolve) => {
      const wait = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        const set = this.waiters.get(barrierId);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(barrierId);
        }
        // Resolve with the current cache snapshot; the sweeper will
        // mark it expired on the next tick if expiresAt has passed.
        const current = this.cache.get(barrierId);
        resolve(current ? cacheToSnapshot(current) : null);
      }, wait);

      const waiter: BarrierWaiter = {
        resolve: (snapshot) => {
          if (timer) clearTimeout(timer);
          resolve(snapshot);
        },
        timer,
      };

      let set = this.waiters.get(barrierId);
      if (!set) {
        set = new Set();
        this.waiters.set(barrierId, set);
      }
      set.add(waiter);
    });
  }

  /**
   * Cancel an open barrier. All waiters resolve immediately with the
   * cancelled snapshot. Idempotent — cancelling a terminal barrier is
   * a no-op that returns the current snapshot.
   */
  async cancel(options: CancelBarrierOptions): Promise<BarrierSnapshot | null> {
    const { barrierId, reason = 'cancelled' } = options;
    const cache =
      this.cache.get(barrierId) ?? (await this.loadFromDb(barrierId));
    if (!cache) return null;
    if (isTerminal(cache.status)) {
      return cacheToSnapshot(cache);
    }
    await this.finalizeBarrier(barrierId, 'cancelled', false, reason);
    const finalCache = this.cache.get(barrierId);
    return finalCache ? cacheToSnapshot(finalCache) : null;
  }

  /** Synchronous snapshot read from cache (no DB hit). */
  peek(barrierId: string): BarrierSnapshot | null {
    const cache = this.cache.get(barrierId);
    return cache ? cacheToSnapshot(cache) : null;
  }

  /**
   * Rebuild the in-memory cache from DB on boot. Call once before
   * serving requests. Also fires any waiters that should already be
   * resolved (a barrier may have completed its release count while
   * this process was down).
   */
  async rehydrateFromDb(): Promise<void> {
    const { loadOpenBarriers } = await import('@/lib/core/db/agent-barriers');
    const { barriers, releases } = await loadOpenBarriers();

    this.cache.clear();
    const releasesByBarrier = new Map<string, AgentBarrierRelease[]>();
    for (const r of releases) {
      const list = releasesByBarrier.get(r.barrierStableId) ?? [];
      list.push(r);
      releasesByBarrier.set(r.barrierStableId, list);
    }

    for (const row of barriers) {
      const rels = releasesByBarrier.get(row.barrierId) ?? [];
      const cache = rowToCache(row, rels);
      this.cache.set(row.barrierId, cache);

      // Re-evaluate the condition: the barrier may have met its
      // condition during the downtime (e.g. all releases landed before
      // this instance restarted).
      const verdict = evaluateCondition(cache);
      if (verdict) {
        // Don't await — fire-and-forget the finalize; the DB row will
        // flip to terminal on next tick.
        void this.finalizeBarrier(
          row.barrierId,
          verdict.status,
          verdict.ok,
          verdict.reason,
        );
      }
    }

    if (barriers.length > 0) {
      logger.info('rehydrated barriers from db', { count: barriers.length });
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private async loadFromDb(barrierId: string): Promise<CachedBarrier | null> {
    const { getBarrier, listBarrierReleases } = await import(
      '@/lib/core/db/agent-barriers'
    );
    const row = await getBarrier(barrierId);
    if (!row) return null;
    const rels = await listBarrierReleases(barrierId);
    const cache = rowToCache(row, rels);
    this.cache.set(barrierId, cache);
    return cache;
  }

  /**
   * Flip the cache to terminal, persist via markBarrierTerminal, and
   * fire all in-process waiters. Idempotent: a second call against an
   * already-terminal barrier is a no-op.
   */
  private async finalizeBarrier(
    barrierId: string,
    status: 'released' | 'cancelled' | 'expired',
    ok: boolean,
    reason?: string,
  ): Promise<void> {
    const cache = this.cache.get(barrierId);
    if (!cache) {
      logger.warn('finalize: barrier not in cache', { barrierId, status });
      return;
    }
    if (isTerminal(cache.status)) {
      return;
    }

    const now = new Date();
    cache.status = status;
    cache.ok = ok;
    cache.reason = reason;
    cache.releasedAt = now.toISOString();

    const snapshot = {
      ok,
      releases: cache.releases,
      releasedAt: now.toISOString(),
      reason,
    };

    try {
      const { markBarrierTerminal } = await import(
        '@/lib/core/db/agent-barriers'
      );
      // markBarrierTerminal is guarded by status='open', so a racing
      // release() can't override our terminal write. If it returns null
      // (already terminal), we don't care — the cache is already correct.
      await markBarrierTerminal({
        barrierStableId: barrierId,
        status,
        result: snapshot,
      });
    } catch (err) {
      logger.error('finalize: db persist failed', {
        barrierId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fire in-process waiters.
    const set = this.waiters.get(barrierId);
    if (set) {
      this.waiters.delete(barrierId);
      const finalSnapshot = cacheToSnapshot(cache);
      for (const waiter of set) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(finalSnapshot);
      }
    }
  }

  private startSweeper() {
    this.sweeper = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  private async sweep() {
    const now = Date.now();
    for (const [barrierId, cache] of this.cache.entries()) {
      if (isTerminal(cache.status)) continue;
      if (!cache.expiresAt) continue;
      if (cache.expiresAt.getTime() > now) continue;

      // Expire it.
      await this.finalizeBarrier(barrierId, 'expired', false, 'expired');

      // Best-effort DB-side sweep for barriers this instance doesn't
      // have cached (e.g. created by a different instance).
      try {
        const { expireStaleBarriers } = await import(
          '@/lib/core/db/agent-barriers'
        );
        await expireStaleBarriers();
      } catch (err) {
        logger.error('sweeper: expireStaleBarriers failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ── Singleton accessor ────────────────────────────────────────────

let registry: BarrierRegistry | null = null;
let rehydratePromise: Promise<void> | null = null;

export function getBarrierRegistry(): BarrierRegistry {
  if (!registry) {
    registry = new BarrierRegistry();
    void rehydrateRegistry();
  }
  return registry;
}

/** Resolved when the registry has rehydrated open barriers from the DB. */
export function awaitBarriersRehydrated(): Promise<void> {
  if (rehydratePromise) return rehydratePromise;
  return Promise.resolve();
}

async function rehydrateRegistry() {
  if (!registry) return;
  rehydratePromise = registry.rehydrateFromDb();
  try {
    await rehydratePromise;
  } catch (err) {
    logger.error('rehydrate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
