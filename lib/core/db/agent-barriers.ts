/**
 * DB layer for the agent_barriers + agent_barrier_releases tables.
 *
 * Stage A of the multi-agent collaboration design: durable backing store
 * for the in-process BarrierRegistry (lib/workflow/agent/barrier.ts).
 *
 * Concurrency contract:
 *   - `releaseBarrier()` is the only writer that increments
 *     agentBarriers.released. It does so atomically inside the same
 *     transaction that inserts an agentBarrierReleases row, guarded by
 *     the (barrier_stable_id, participant_id) unique index — so a
 *     duplicate release is a no-op (the insert fails fast, released is
 *     not bumped).
 *   - `markBarrierTerminal()` is the only writer that flips status to a
 *     terminal value (released | cancelled | expired). It is guarded by
 *     the `status IN ('open')` WHERE clause, so a terminal write from a
 *     racing release() cannot be reverted by a late cancel().
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import {
  agentBarriers,
  agentBarrierReleases,
  type AgentBarrier,
  type AgentBarrierRelease,
} from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('db.agent-barriers');

export type BarrierMode = 'all' | 'quorum' | 'first_ok' | 'first_fail';
export type BarrierStatus = 'open' | 'released' | 'cancelled' | 'expired';

const ACTIVE_STATUS: BarrierStatus = 'open';

export interface CreateBarrierInput {
  barrierId: string;
  sessionId?: string;
  runId?: string;
  expected: number;
  mode?: BarrierMode;
  quorum?: number;
  expiresAt?: Date;
}

export interface ReleaseInput {
  barrierStableId: string;
  participantId: string;
  ok: boolean;
  payload?: unknown;
}

export interface ReleaseOutcome {
  /** The release row was inserted (false = duplicate participant,
   *  ignored by the unique index). */
  accepted: boolean;
  /** Barrier row snapshot after this release. */
  barrier: AgentBarrier | null;
  /** All accepted releases so far, including this one (only populated
   *  when the barrier just transitioned to terminal, so the caller can
   *  snapshot `result` cheaply without a second query). */
  releases: AgentBarrierRelease[];
}

/** Insert a fresh barrier row (status defaults to 'open'). */
export async function createBarrier(
  input: CreateBarrierInput,
): Promise<AgentBarrier> {
  const [row] = await db
    .insert(agentBarriers)
    .values({
      barrierId: input.barrierId,
      sessionId: input.sessionId,
      runId: input.runId,
      expected: input.expected,
      mode: input.mode ?? 'all',
      quorum: input.quorum,
      status: ACTIVE_STATUS,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row;
}

/** Lookup by the stable barrier_id (not the uuid PK). */
export async function getBarrier(
  barrierStableId: string,
): Promise<AgentBarrier | null> {
  const [row] = await db
    .select()
    .from(agentBarriers)
    .where(eq(agentBarriers.barrierId, barrierStableId))
    .limit(1);
  return row ?? null;
}

/** List all still-open barriers, optionally scoped to a session or run. */
export async function listOpenBarriers(opts?: {
  sessionId?: string;
  runId?: string;
}): Promise<AgentBarrier[]> {
  const conditions = [eq(agentBarriers.status, ACTIVE_STATUS)];
  if (opts?.sessionId) {
    conditions.push(eq(agentBarriers.sessionId, opts.sessionId));
  }
  if (opts?.runId) {
    conditions.push(eq(agentBarriers.runId, opts.runId));
  }
  return db
    .select()
    .from(agentBarriers)
    .where(and(...conditions))
    .orderBy(desc(agentBarriers.createdAt));
}

/**
 * Idempotent release. Inserts an agentBarrierReleases row (uniqueness
 * on (barrier_stable_id, participant_id) dedupes repeats), then
 * atomically increments agentBarriers.released when the insert
 * succeeded. Returns the post-release barrier row plus the inserted
 * release row(s) so the caller can decide whether to fire the
 * terminal transition.
 *
 * On a duplicate participant the unique index raises; we catch it and
 * return `{ accepted: false, barrier, releases: [] }` so the registry
 * can treat the call as a no-op.
 *
 * The increment and the release-row insert are intentionally NOT in a
 * single transaction: a duplicate participant would otherwise leave
 * released permanently off-by-one vs the audit trail. By inserting the
 * audit row first (the dedup gate) and only incrementing on success,
 * released always equals COUNT(*) of agentBarrierReleases for that
 * barrier.
 */
export async function releaseBarrier(
  input: ReleaseInput,
): Promise<ReleaseOutcome> {
  // Resolve barrier row first so we can short-circuit on terminal state.
  const barrier = await getBarrier(input.barrierStableId);
  if (!barrier) {
    return { accepted: false, barrier: null, releases: [] };
  }
  if (barrier.status !== ACTIVE_STATUS) {
    // Already terminal; ignore late releases.
    return { accepted: false, barrier, releases: [] };
  }

  let inserted: AgentBarrierRelease | null = null;
  try {
    const [row] = await db
      .insert(agentBarrierReleases)
      .values({
        barrierId: barrier.id,
        barrierStableId: input.barrierStableId,
        participantId: input.participantId,
        ok: input.ok,
        payload: input.payload as Record<string, unknown> | null,
      })
      .returning();
    inserted = row ?? null;
  } catch (err) {
    // Duplicate participant — unique index fired. Treat as accepted=false.
    logger.info('release: duplicate participant ignored', {
      barrierId: input.barrierStableId,
      participantId: input.participantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { accepted: false, barrier, releases: [] };
  }

  // Increment released counter on the parent row.
  const [updated] = await db
    .update(agentBarriers)
    .set({ released: sql`${agentBarriers.released} + 1` })
    .where(eq(agentBarriers.id, barrier.id))
    .returning();

  return {
    accepted: true,
    barrier: updated ?? barrier,
    releases: inserted ? [inserted] : [],
  };
}

/**
 * List every accepted release for a barrier, oldest first. Used by the
 * registry to snapshot `result` when transitioning to terminal, and by
 * `status`/UI queries.
 */
export async function listBarrierReleases(
  barrierStableId: string,
): Promise<AgentBarrierRelease[]> {
  return db
    .select()
    .from(agentBarrierReleases)
    .where(eq(agentBarrierReleases.barrierStableId, barrierStableId))
    .orderBy(agentBarrierReleases.releasedAt);
}

/**
 * Flip a barrier to a terminal status (released | cancelled | expired)
 * and snapshot the aggregated `result`. Guarded by status='open' so a
 * racing release cannot override a terminal write.
 *
 * Returns the updated row, or null if the barrier was already terminal
 * (the caller should treat null as "someone else finished it first").
 */
export async function markBarrierTerminal(input: {
  barrierStableId: string;
  status: Exclude<BarrierStatus, 'open'>;
  result: NonNullable<AgentBarrier['result']>;
}): Promise<AgentBarrier | null> {
  const now = new Date();
  const [row] = await db
    .update(agentBarriers)
    .set({
      status: input.status,
      result: input.result,
      releasedAt: now,
    })
    .where(
      and(
        eq(agentBarriers.barrierId, input.barrierStableId),
        eq(agentBarriers.status, ACTIVE_STATUS),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Sweeper: mark every still-open barrier whose expiresAt is in the past
 * as expired. Returns the swept rows so the registry can fire the
 * in-process resolver for any local waiter (which then sees status=
 * expired and returns the timeout result).
 *
 * Run on a timer (see barrier-index.ts) and safe to call opportunistically.
 */
export async function expireStaleBarriers(): Promise<AgentBarrier[]> {
  const now = new Date();
  const stale = await db
    .select()
    .from(agentBarriers)
    .where(
      and(
        eq(agentBarriers.status, ACTIVE_STATUS),
        lt(agentBarriers.expiresAt, now),
      ),
    );

  if (stale.length === 0) return [];

  const staleIds = stale.map((r) => r.barrierId);
  await db
    .update(agentBarriers)
    .set({
      status: 'expired',
      releasedAt: now,
      result: {
        ok: false,
        releases: [],
        releasedAt: now.toISOString(),
        reason: 'expired',
      },
    })
    .where(
      and(
        inArray(agentBarriers.barrierId, staleIds),
        eq(agentBarriers.status, ACTIVE_STATUS),
      ),
    );

  logger.warn('expired stale barriers', { count: staleIds.length });
  return stale;
}

/**
 * Rehydrate: load all open barriers and their releases. Called by the
 * registry on startup so a fresh Vercel instance picks up waiters that
 * survived from a previous deployment.
 *
 * Returns `{ barriers, releases }` so the registry can rebuild both the
 * open-barrier index and the per-barrier release counts in one pass.
 */
export async function loadOpenBarriers(): Promise<{
  barriers: AgentBarrier[];
  releases: AgentBarrierRelease[];
}> {
  const barriers = await listOpenBarriers();
  if (barriers.length === 0) {
    return { barriers: [], releases: [] };
  }
  const ids = barriers.map((b) => b.barrierId);
  const releases = await db
    .select()
    .from(agentBarrierReleases)
    .where(inArray(agentBarrierReleases.barrierStableId, ids))
    .orderBy(agentBarrierReleases.releasedAt);
  return { barriers, releases };
}

// Re-export types for callers.
export type { AgentBarrier, AgentBarrierRelease };
