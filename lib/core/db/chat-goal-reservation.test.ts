/**
 * PGlite-backed tests for the goal DAL functions that carry an
 * optimistic-lock / validation invariant:
 *   - setSessionGoal enforces MAX_GOAL_OBJECTIVE_CHARS at the DAL edge
 *     (code review C7 — the schema comment promises "DAL edge" enforcement
 *     that the plain UPDATE used to skip).
 *   - reserveGoalContinuation is the optimistic-lock gate for the
 *     post-run hidden-continuation (code review I): it must return null
 *     (and NOT bump counters) when goal_text has been cleared between the
 *     evaluator reading the goal and the cleanup trying to resume.
 *
 * Runs against a real in-memory Postgres (PGlite) so the `goal_text IS NOT
 * NULL` predicate and the `col + delta` SQL both execute exactly as in
 * production. Mirrors the harness pattern in agentd.workspaces.test.ts.
 *
 * Run via: yarn test lib/core/db/chat-goal-reservation.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

// Minimal sessions table mirroring schema/chat.ts. Production's
// sessions table has many NOT NULL/defaulted columns; drizzle's insert
// emits every column (with default for the ones we don't set), so the DDL
// must cover them all or the insert fails with 42703 (undefined column).
const DDL = [
  `CREATE TABLE "sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "title" text,
    "channel" text DEFAULT 'web' NOT NULL,
    "channel_origin" text,
    "external_thread_id" text,
    "user_id" text,
    "workspace_id" uuid,
    "visibility" text DEFAULT 'private' NOT NULL,
    "model" text,
    "system_prompt" text,
    "soul_content" text,
    "status" text DEFAULT 'active' NOT NULL,
    "workflow_run_id" text,
    "sandbox_id" text,
    "remote_control_node_id" text,
    "total_tokens" integer DEFAULT 0 NOT NULL,
    "latest_token_usage" jsonb,
    "metadata" jsonb,
    "archived" boolean DEFAULT false NOT NULL,
    "goal_text" text,
    "goal_set_at" timestamptz,
    "hidden_continuation_count" integer DEFAULT 0 NOT NULL,
    "consecutive_non_progress" integer DEFAULT 0 NOT NULL,
    "last_eval_reason" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
];

const harness = setupPgLiteTestDb(DDL);

// Production code imports `db`, `schema`, and `resolveDriver` from
// @/lib/core/db. We mock that module to inject the PGlite drizzle
// instance while re-exporting the real schema (the DAL queries reference
// schema.tables.* column refs, which must be the same objects the harness
// db was built with).
vi.mock('@/lib/core/db', async () => {
  const schemaMod = await import('@/lib/core/db/schema');
  return {
    get db() {
      return harness.db;
    },
    resolveDriver: () => 'postgres' as const,
    schema: schemaMod,
  };
});

import {
  incrementGoalCounters,
  reserveGoalContinuation,
  setSessionGoal,
} from '@/lib/core/db/chat';
import { schema } from '@/lib/core/db';

async function seedSession(
  overrides: Partial<{
    goalText: string | null;
    hiddenContinuationCount: number;
    consecutiveNonProgress: number;
    lastEvalReason: string | null;
  }> = {},
): Promise<string> {
  // `?? ` would coerce an explicit null goalText to 'ship it' and silently
  // defeat the "goal cleared" tests below, so distinguish undefined from null.
  const goalText =
    overrides.goalText === undefined ? 'ship it' : overrides.goalText;
  const [row] = await harness.db
    .insert(schema.sessions)
    .values({
      goalText,
      hiddenContinuationCount: overrides.hiddenContinuationCount ?? 0,
      consecutiveNonProgress: overrides.consecutiveNonProgress ?? 0,
      lastEvalReason: overrides.lastEvalReason ?? null,
    })
    .returning({ id: schema.sessions.id });
  if (!row) throw new Error('Failed to seed session');
  return row.id;
}

async function readSession(id: string) {
  const [row] = await harness.db
    .select({
      goalText: schema.sessions.goalText,
      hiddenContinuationCount: schema.sessions.hiddenContinuationCount,
      consecutiveNonProgress: schema.sessions.consecutiveNonProgress,
      lastEvalReason: schema.sessions.lastEvalReason,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .limit(1);
  if (!row) throw new Error(`Session ${id} not found`);
  return row;
}

describe('setSessionGoal (DAL length guard — C7)', () => {
  beforeEach(() => resetDb(harness.db, ['sessions']));

  it('accepts a goal at exactly MAX_GOAL_OBJECTIVE_CHARS (4000)', async () => {
    const id = await seedSession({ goalText: null });
    const goal = 'x'.repeat(4000);
    const row = await setSessionGoal(id, goal);
    expect(row?.goalText).toBe(goal);
  });

  it('rejects a goal over MAX_GOAL_OBJECTIVE_CHARS at the DAL edge', async () => {
    const id = await seedSession({ goalText: null });
    await expect(setSessionGoal(id, 'x'.repeat(4001))).rejects.toThrow(
      /too long/i,
    );
    // And the row must be untouched.
    expect((await readSession(id)).goalText).toBeNull();
  });
});

describe('reserveGoalContinuation (optimistic lock — I)', () => {
  beforeEach(() => resetDb(harness.db, ['sessions']));

  it('bumps the counters and returns the row when the goal is still set', async () => {
    const id = await seedSession({
      goalText: 'ship it',
      hiddenContinuationCount: 2,
    });
    const reserved = await reserveGoalContinuation(id, {
      hiddenDelta: 1,
      nonProgressDelta: 1,
      lastEvalReason: 'still working',
    });
    expect(reserved).not.toBeNull();
    const after = await readSession(id);
    expect(after.hiddenContinuationCount).toBe(3);
    expect(after.consecutiveNonProgress).toBe(1);
    expect(after.lastEvalReason).toBe('still working');
  });

  it('returns null and leaves counters untouched when the goal was cleared mid-flight', async () => {
    // Simulate the race: evaluator read goal_text='ship it', then a
    // concurrent /goal clear nulled goal_text. The reservation must fail
    // the optimistic-lock predicate and NOT burn a continuation slot.
    const id = await seedSession({
      goalText: null, // cleared between read and reserve
      hiddenContinuationCount: 0,
    });
    const reserved = await reserveGoalContinuation(id, {
      hiddenDelta: 1,
      lastEvalReason: 'still working',
    });
    expect(reserved).toBeNull();
    const after = await readSession(id);
    expect(after.hiddenContinuationCount).toBe(0); // untouched
    expect(after.lastEvalReason).toBeNull();
  });

  it('resetNonProgress writes an absolute 0 (not col + n)', async () => {
    const id = await seedSession({
      goalText: 'ship it',
      consecutiveNonProgress: 5,
    });
    await reserveGoalContinuation(id, {
      hiddenDelta: 1,
      resetNonProgress: true,
      lastEvalReason: 'new direction',
    });
    const after = await readSession(id);
    expect(after.consecutiveNonProgress).toBe(0);
  });

  it('COALESCE guards a NULL legacy counter column (C8)', async () => {
    // Pre-migration rows could have NULL counters (no DEFAULT, no NOT NULL).
    // The COALESCE(...,0) wrapper must let the bump land at 0 + delta rather
    // than writing NULL. PGlite enforces NOT NULL on our test table, so we
    // DROP and recreate the column nullable to simulate the legacy shape,
    // then verify the DAL's COALESCE-guarded expression reads it as 0.
    const id = await seedSession({ goalText: 'ship it' });
    await harness.db.execute(
      'ALTER TABLE "sessions" ALTER COLUMN "hidden_continuation_count" DROP NOT NULL',
    );
    try {
      // Parameterized via the Drizzle query builder instead of string-
      // concatenating `id` into the SQL — the id is server-generated and
      // not user-controlled, but string-concatenation still has no place
      // in a test that exists to assert safe SQL patterns. The column's
      // $inferInsert type disallows `null` (it's NOT NULL in schema), so
      // we reach for a raw `sql` expression to write NULL for this
      // legacy-row simulation.
      await harness.db
        .update(schema.sessions)
        .set({
          hiddenContinuationCount: sql`NULL`,
        })
        .where(eq(schema.sessions.id, id));
      // incrementGoalCounters is the non-gated sibling; verify it too. A
      // missing COALESCE would write NULL here (NULL + 1 = NULL in SQL).
      await incrementGoalCounters(id, { hiddenDelta: 1 });
      const after = await readSession(id);
      expect(after.hiddenContinuationCount).toBe(1);
    } finally {
      // Restore the NOT NULL constraint so this schema mutation does not
      // leak into sibling tests (this `describe` block has a per-test
      // `beforeEach` reset, but resetDb truncates rows, not DDL).
      await harness.db.execute(
        'ALTER TABLE "sessions" ALTER COLUMN "hidden_continuation_count" SET NOT NULL',
      );
    }
  });

  it('clamps a negative delta at zero (compensating-rollback race)', async () => {
    // Regression for the post-run-cleanup compensating rollback:
    // reserveGoalContinuation bumps hiddenContinuationCount 0→1; then a
    // concurrent /goal clear (or setSessionGoal) zeroes the counter; then
    // resumeWithMessage throws and cleanup calls incrementGoalCounters
    // with hiddenDelta: -1 to compensate. Without a floor, the rollback
    // would underflow the reset counter to -1. GREATEST(..., 0) keeps it
    // pinned at zero. Covers both the gated (reserve) and non-gated
    // (increment) writers since they share buildGoalCounterPatch.
    const id = await seedSession({
      goalText: 'ship it',
      hiddenContinuationCount: 0,
    });
    await incrementGoalCounters(id, { hiddenDelta: -1 });
    expect((await readSession(id)).hiddenContinuationCount).toBe(0);

    // Same guard on the consecutive_non_progress counter.
    const id2 = await seedSession({
      goalText: 'ship it',
      consecutiveNonProgress: 0,
    });
    await incrementGoalCounters(id2, { nonProgressDelta: -1 });
    expect((await readSession(id2)).consecutiveNonProgress).toBe(0);
  });
});
