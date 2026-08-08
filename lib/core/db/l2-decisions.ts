/**
 * DB layer for the l2_decisions table.
 *
 * P0.2: Durable persistence for the L2/ask_question decision queue.
 * The in-memory DecisionQueue (lib/security/l2-decision-queue.ts) is a
 * hot cache in front of this layer; every enqueue/resolve/deny/expire
 * touches both. On startup the queue rehydrates from this table.
 */

import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { l2Decisions, sessions, type L2Decision } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('db.l2-decisions');

const ACTIVE_STATUSES = ['pending', 'sent'] as const;
const TERMINAL_STATUSES = ['resolved', 'denied', 'expired', 'timeout'] as const;

export type DecisionStatus =
  | (typeof ACTIVE_STATUSES)[number]
  | (typeof TERMINAL_STATUSES)[number];

export interface UpsertDecisionInput {
  decisionId: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  status?: string;
  nodeId?: string;
  userId?: string | null;
  expiresAt: Date;
}

/** Insert a fresh decision row (status defaults to 'pending'). */
export async function createDecision(
  input: UpsertDecisionInput,
): Promise<L2Decision> {
  const [row] = await db
    .insert(l2Decisions)
    .values({
      decisionId: input.decisionId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      type: input.type,
      status: input.status ?? 'pending',
      payload: input.payload,
      nodeId: input.nodeId,
      userId: input.userId ?? null,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row;
}

/**
 * Lookup by the stable decision_id (not the uuid PK).
 */
export async function getDecision(
  decisionId: string,
): Promise<L2Decision | null> {
  const [row] = await db
    .select()
    .from(l2Decisions)
    .where(eq(l2Decisions.decisionId, decisionId))
    .limit(1);
  return row ?? null;
}

/**
 * List active decisions (pending + sent), newest-first by default.
 * Optionally filter by session or task.
 */
export async function listActiveDecisions(opts?: {
  sessionId?: string;
  taskId?: string;
  sessionIds?: readonly string[];
}): Promise<L2Decision[]> {
  const conditions = [inArray(l2Decisions.status, [...ACTIVE_STATUSES])];
  if (opts?.sessionId) {
    conditions.push(eq(l2Decisions.sessionId, opts.sessionId));
  }
  if (opts?.taskId) {
    conditions.push(eq(l2Decisions.taskId, opts.taskId));
  }
  if (opts?.sessionIds && opts.sessionIds.length > 0) {
    conditions.push(inArray(l2Decisions.sessionId, [...opts.sessionIds]));
  }
  return db
    .select()
    .from(l2Decisions)
    .where(and(...conditions))
    .orderBy(desc(l2Decisions.createdAt));
}

/**
 * Mark a decision resolved with the given action and optional reply payload.
 */
export async function resolveDecision(
  decisionId: string,
  resolvedBy: string,
  resolution: Record<string, unknown>,
  status: 'resolved' | 'denied' = 'resolved',
): Promise<L2Decision | null> {
  const [row] = await db
    .update(l2Decisions)
    .set({
      status,
      resolvedBy,
      resolvedAt: new Date(),
      resolution,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(l2Decisions.decisionId, decisionId),
        inArray(l2Decisions.status, [...ACTIVE_STATUSES]),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Mark a single decision as expired/timeout. Used by the watchdog and
 * for forwarding rejection back to the daemon.
 */
export async function markExpired(
  decisionId: string,
  status: 'expired' | 'timeout' = 'expired',
): Promise<L2Decision | null> {
  const [row] = await db
    .update(l2Decisions)
    .set({
      status,
      resolvedAt: new Date(),
      resolvedBy: 'system',
      updatedAt: new Date(),
    })
    .where(eq(l2Decisions.decisionId, decisionId))
    .returning();
  return row ?? null;
}

/**
 * Look up the owning userId for a sessionId. Used at enqueue time to
 * populate l2_decisions.user_id so the queue can group decisions by
 * user across all of that user's sessions (the isolation key for
 * canPromote). Returns null for unknown sessions or sessions without
 * an owner.
 */
export async function getUserIdBySession(
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Promote a decision from 'pending' to 'sent' (visible to the UI).
 * Used by the in-memory queue so the DB mirrors the cache when a
 * decision is promoted — otherwise a different serverless instance
 * rehydrating from DB would never see the 'sent' status and the UI
 * would never render the prompt (the "ghost decision" bug).
 *
 * Only transitions 'pending' → 'sent'; rows already in a terminal or
 * 'sent' state are left untouched (returns null).
 */
export async function markSent(decisionId: string): Promise<L2Decision | null> {
  const [row] = await db
    .update(l2Decisions)
    .set({
      status: 'sent',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(l2Decisions.decisionId, decisionId),
        eq(l2Decisions.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Sweep all active decisions whose expiresAt is in the past, marking
 * them expired. Returns the swept rows so callers can forward
 * rejections back to the originating daemon nodes.
 *
 * Runs on a timer (see lib/security/l2-index.ts) and is also safe to
 * call opportunistically from list endpoints.
 */
export async function expireStaleDecisions(): Promise<L2Decision[]> {
  const now = new Date();
  const stale = await db
    .select()
    .from(l2Decisions)
    .where(
      and(
        inArray(l2Decisions.status, [...ACTIVE_STATUSES]),
        lt(l2Decisions.expiresAt, now),
      ),
    );

  if (stale.length === 0) return [];

  const staleIds = stale.map((r) => r.decisionId);
  await db
    .update(l2Decisions)
    .set({
      status: 'expired',
      resolvedAt: now,
      resolvedBy: 'system',
      updatedAt: now,
    })
    .where(
      and(
        inArray(l2Decisions.decisionId, staleIds),
        inArray(l2Decisions.status, [...ACTIVE_STATUSES]),
      ),
    );

  logger.warn('expired stale decisions', { count: staleIds.length });
  return stale;
}

/**
 * Rehydrate: load all active decisions from DB. Called by the queue
 * on startup so an in-memory Vercel instance picks up work that
 * survived from a previous deployment.
 */
export async function loadActiveDecisions(): Promise<L2Decision[]> {
  return listActiveDecisions();
}

/**
 * Count decisions matching a status, optionally filtered by task.
 * Used for the per-task concurrency cap.
 */
export async function countByStatus(
  status: DecisionStatus,
  taskId?: string,
): Promise<number> {
  const conditions = [eq(l2Decisions.status, status)];
  if (taskId) conditions.push(eq(l2Decisions.taskId, taskId));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(l2Decisions)
    .where(and(...conditions));
  return row?.n ?? 0;
}

// Re-export types for callers.
export type { L2Decision };

// Silence unused-import warnings for query operators that future
// extensions of this module will use (status type unions, etc.).
void or;
void gt;
void TERMINAL_STATUSES;
