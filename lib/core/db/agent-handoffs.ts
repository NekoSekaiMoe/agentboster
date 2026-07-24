/**
 * DB layer for the agent_handoffs table.
 *
 * Phase B of the multi-agent collaboration design. A durable mailbox
 * for cross-session agent messages. The DB helpers below are intentionally
 * thin — concurrency control is the caller's responsibility. The
 * intended access patterns:
 *
 *   - One producer puts a handoff (`putHandoff`).
 *   - One consumer takes it (`takeHandoff` = destructive read) or peeks
 *     (`peekHandoffs` = non-destructive list).
 *
 * For broadcast handoffs (`to_session_id IS NULL`), the FIRST take()
 * wins — there is no built-in claim mechanism. If you need fan-out to
 * N recipients, use N targeted handoffs (one per `toSessionId`) or a
 * barrier to coordinate.
 *
 * `releaseLinkedBarrier` is a convenience that releases the barrier
 * linked via `barrier_id` after a take/put, so a workflow waiting on
 * `waitForBarrier()` can resume. It is best-effort: a failed release
 * (barrier already terminal, missing, etc.) is logged but does not
 * fail the calling step.
 */

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { agentHandoffs, type AgentHandoff } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('db.agent-handoffs');

export interface PutHandoffInput {
  fromSessionId?: string;
  toSessionId?: string;
  runId?: string;
  barrierId?: string;
  key: string;
  payload?: unknown;
}

export interface TakeHandoffQuery {
  /** The session reading the handoff. Matches both targeted rows
   *  (toSessionId === thisSession) and broadcasts (toSessionId IS NULL). */
  forSessionId?: string;
  key: string;
  /** When true, only consume broadcast handoffs (toSessionId IS NULL).
   *  Useful for "any taker" semantics when the reader doesn't want to
   *  claim another session's targeted mail. */
  broadcastsOnly?: boolean;
}

/** Insert a handoff row. Returns the persisted row. */
export async function putHandoff(
  input: PutHandoffInput,
): Promise<AgentHandoff> {
  const [row] = await db
    .insert(agentHandoffs)
    .values({
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      runId: input.runId,
      barrierId: input.barrierId,
      key: input.key,
      payload: input.payload as Record<string, unknown> | null,
    })
    .returning();
  return row;
}

/**
 * Destructive read: return the oldest matching row and delete it.
 * Returns null when no handoff is waiting.
 *
 * Match rules (when `forSessionId` is set):
 *   - rows where `toSessionId === forSessionId`, OR
 *   - rows where `toSessionId IS NULL` (broadcasts)
 * unless `broadcastsOnly` is true, in which case only the second.
 *
 * When `forSessionId` is unset, returns any row matching the key
 * (callers that don't care about scoping).
 *
 * Concurrency: implemented as peek+delete-by-id. Two concurrent
 * take() calls can both receive the same row, but only one of the
 * subsequent deletes will affect a row (the other deletes 0 rows and
 * returns null). For true exactly-once fan-out across N consumers,
 * use targeted handoffs (one per recipient session).
 */
export async function takeHandoff(
  query: TakeHandoffQuery,
): Promise<AgentHandoff | null> {
  const candidates = await peekHandoffs(query);
  if (candidates.length === 0) return null;
  const target = candidates[0];
  const [deleted] = await db
    .delete(agentHandoffs)
    .where(eq(agentHandoffs.id, target.id))
    .returning();
  return deleted ?? null;
}

/**
 * Non-destructive list. Returns every matching row, oldest first.
 * Same match rules as takeHandoff but does not delete.
 */
export async function peekHandoffs(
  query: TakeHandoffQuery,
): Promise<AgentHandoff[]> {
  const conditions = [eq(agentHandoffs.key, query.key)];
  if (query.forSessionId) {
    if (query.broadcastsOnly) {
      conditions.push(isNull(agentHandoffs.toSessionId));
    } else {
      // drizzle's or() returns SQL | undefined; in practice the result
      // is always defined when both args are valid expressions. We
      // guard against the undefined branch explicitly to satisfy
      // noNonNullAssertion and to keep the runtime honest.
      const recipientExpr = or(
        eq(agentHandoffs.toSessionId, query.forSessionId),
        isNull(agentHandoffs.toSessionId),
      );
      if (recipientExpr) {
        conditions.push(recipientExpr);
      }
    }
  } else if (query.broadcastsOnly) {
    conditions.push(isNull(agentHandoffs.toSessionId));
  }
  return db
    .select()
    .from(agentHandoffs)
    .where(and(...conditions))
    .orderBy(asc(agentHandoffs.id));
}

/**
 * List handoffs produced by a session (any key, any recipient). Useful
 * for audits and "what did I send?" UI views.
 */
export async function listHandoffsByFromSession(
  fromSessionId: string,
): Promise<AgentHandoff[]> {
  return db
    .select()
    .from(agentHandoffs)
    .where(eq(agentHandoffs.fromSessionId, fromSessionId))
    .orderBy(asc(agentHandoffs.id));
}

/**
 * Best-effort barrier release. Called by the handoff tool after a
 * put/take that links to a barrier; the barrier's owner (often a
 * different workflow run waiting on waitForBarrier) is then unblocked.
 *
 * Errors are logged and swallowed — a failed release should not roll
 * back the handoff that triggered it.
 */
export async function releaseLinkedBarrier(
  barrierId: string,
  participantId: string,
  ok: boolean,
  payload?: unknown,
): Promise<void> {
  try {
    const { getBarrierRegistry } = await import('@/lib/workflow/agent/barrier');
    const registry = getBarrierRegistry();
    await registry.release({ barrierId, participantId, ok, payload });
  } catch (err) {
    logger.warn('releaseLinkedBarrier: failed', {
      barrierId,
      participantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * List handoffs where the given session is either the producer (from) or the
 * targeted consumer (to). Broadcasts (toSessionId null) from this session are
 * included; broadcasts from OTHER sessions are not (they have no specific
 * recipient and could be claimed by anyone). Used by the read-only
 * orchestration graph view to draw session-internal handoff edges.
 */
export async function listHandoffsForSession(
  sessionId: string,
): Promise<AgentHandoff[]> {
  const recipientExpr = or(
    eq(agentHandoffs.fromSessionId, sessionId),
    eq(agentHandoffs.toSessionId, sessionId),
  );
  if (!recipientExpr) {
    return [];
  }
  return db
    .select()
    .from(agentHandoffs)
    .where(recipientExpr)
    .orderBy(asc(agentHandoffs.id));
}
