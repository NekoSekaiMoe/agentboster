/**
 * DAL for the `dream_runs` audit table.
 *
 * Single owner of dream_runs drizzle access (Repository pattern, same as
 * the long-term memory DAL). The orchestrator is the only writer; the
 * UI/admin surfaces read through here as well.
 */

import { desc, eq } from 'drizzle-orm';

import { db, schema } from '@/lib/core/db';

/**
 * Insert a dream run audit row. Returns the inserted row (with id).
 */
export async function insertDreamRun(input: {
  userId: string;
  startedAt: Date;
  finishedAt: Date | null;
  phases: string;
  operations: unknown[];
  result: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(schema.dreamRuns)
    .values({
      userId: input.userId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      phases: input.phases,
      operations: input.operations,
      result: input.result,
    })
    .returning();
  return row;
}

/**
 * Update the finishedAt + result of an in-progress run. Used when the
 * orchestrator starts the run (insert) then applies operations and only
 * later knows the final result.
 */
export async function completeDreamRun(input: {
  id: string;
  finishedAt: Date;
  operations: unknown[];
  result: Record<string, unknown>;
}) {
  const [row] = await db
    .update(schema.dreamRuns)
    .set({
      finishedAt: input.finishedAt,
      operations: input.operations,
      result: input.result,
    })
    .where(eq(schema.dreamRuns.id, input.id))
    .returning();
  return row ?? null;
}

/**
 * List recent dream runs for a user (newest first). Used by the admin /
 * memory UI to show "what Dream did last night".
 */
export async function listRecentDreamRuns(input: {
  userId: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  return db
    .select()
    .from(schema.dreamRuns)
    .where(eq(schema.dreamRuns.userId, input.userId))
    .orderBy(desc(schema.dreamRuns.startedAt))
    .limit(limit);
}
