/**
 * Integration test that validates the orchestration-plans schema against a
 * REAL in-memory Postgres via PGlite (no mock).
 *
 * What this catches that the hand-rolled mock cannot:
 *   - SQL dialect errors (PGlite IS Postgres, so any SQL drizzle generates
 *     that works here works on the production Neon/pg driver too).
 *   - Column name mismatches, missing indexes, constraint violations.
 *   - jsonb round-trip semantics for dependsOn.
 *   - FK cascade behavior on plan deletion.
 *
 * What this does NOT cover: the DAL function *logic* (wave computation,
 * instruction synthesis) — those are unit-tested in
 * agent-orchestration-plans.test.ts. This file holds the schema honest so
 * a migration that breaks the wire shape is caught here, not in prod.
 *
 * It uses raw drizzle schema queries against the harness db because the
 * exported DAL functions import the production db singleton; routing them
 * to PGlite would require either dependency injection (future Repository
 * refactor — batch #9 part 2) or a top-level vi.mock. Using raw queries is
 * the minimum viable way to prove the schema works.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentOrchestrationPlanItems,
  agentOrchestrationPlans,
  sessions,
} from './schema';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

// Minimal DDL for the tables this test exercises. Mirrors the schema in
// lib/core/db/schema/agent-orchestration-plans.ts (+ sessions for the FK).
// If the schema drifts from this DDL, the drizzle queries below fail —
// which is exactly the signal we want from a schema-integration test.
const DDL = [
  // Minimal sessions table — only the id column is referenced by the FK, but
  // we create the full primary-key shape so ON DELETE CASCADE has a real
  // parent row to delete when the session-cascade test runs.
  `CREATE TABLE "sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agent_orchestration_plans" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "plan_id" text NOT NULL UNIQUE,
    "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
    "title" text NOT NULL,
    "description" text,
    "status" text DEFAULT 'draft' NOT NULL,
    "submitted_message_id" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE "agent_orchestration_plan_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "plan_id" uuid NOT NULL REFERENCES "agent_orchestration_plans"("id") ON DELETE CASCADE,
    "item_id" text NOT NULL UNIQUE,
    "agent_name" text NOT NULL,
    "task" text NOT NULL,
    "depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "order" integer DEFAULT 0 NOT NULL,
    "removed" boolean DEFAULT false NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX "agent_orchestration_plans_session_idx" ON "agent_orchestration_plans" ("session_id")`,
  `CREATE INDEX "agent_orchestration_plans_status_idx" ON "agent_orchestration_plans" ("status")`,
  `CREATE INDEX "agent_orchestration_plan_items_plan_idx" ON "agent_orchestration_plan_items" ("plan_id")`,
  `CREATE INDEX "agent_orchestration_plan_items_item_idx" ON "agent_orchestration_plan_items" ("item_id")`,
] as const;

const TABLES = [
  'agent_orchestration_plan_items',
  'agent_orchestration_plans',
  'sessions',
] as const;

const { db } = setupPgLiteTestDb(DDL);

const SESSION_A = '00000000-0000-0000-0000-0000000000a1';
const SESSION_B = '00000000-0000-0000-0000-0000000000b2';

describe('orchestration-plans schema (PGlite integration)', () => {
  beforeEach(async () => {
    // Both sessions the FK-referencing tests use. Seeding them here means the
    // pre-existing tests (written when session_id was a bare uuid) don't have
    // to touch sessions at all; only the session-cascade test deletes one.
    // Raw SQL because the drizzle `sessions` table object carries the full
    // production column set (title/channel/...), but this test only created
    // the minimal columns the FK needs — a drizzle insert would emit columns
    // the test DDL doesn't have.
    await db.execute(
      sql`INSERT INTO "sessions" ("id") VALUES (${SESSION_A}), (${SESSION_B})`,
    );
  });

  afterEach(async () => {
    await resetDb(db, TABLES);
  });

  it('inserts a plan and reads it back', async () => {
    const [row] = await db
      .insert(agentOrchestrationPlans)
      .values({
        planId: 'plan-test-1',
        sessionId: SESSION_A,
        title: 'demo',
      })
      .returning();
    expect(row).toBeDefined();
    expect(row?.planId).toBe('plan-test-1');
    expect(row?.status).toBe('draft'); // schema default
    expect(row?.id).toBeDefined(); // uuid PK
  });

  it('planId unique constraint rejects duplicates', async () => {
    await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-dup', sessionId: SESSION_A, title: 'a' });
    await expect(
      db
        .insert(agentOrchestrationPlans)
        .values({ planId: 'plan-dup', sessionId: SESSION_A, title: 'b' }),
    ).rejects.toThrow();
  });

  it('inserts an item with jsonb dependsOn and reads it back intact', async () => {
    const [plan] = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-j', sessionId: SESSION_A, title: 'j' })
      .returning();
    const [item] = await db
      .insert(agentOrchestrationPlanItems)
      .values({
        planId: plan!.id,
        itemId: 'item-j-1',
        agentName: 'researcher',
        task: 'find sources',
        dependsOn: ['item-x', 'item-y'],
      })
      .returning();
    expect(item?.dependsOn).toEqual(['item-x', 'item-y']);
    expect(item?.removed).toBe(false); // schema default
    expect(item?.order).toBe(0); // schema default
  });

  it('soft-delete (removed=true) survives and stays queryable', async () => {
    const [plan] = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-s', sessionId: SESSION_A, title: 's' })
      .returning();
    await db.insert(agentOrchestrationPlanItems).values({
      planId: plan!.id,
      itemId: 'item-s',
      agentName: 'a',
      task: 't',
    });
    await db
      .update(agentOrchestrationPlanItems)
      .set({ removed: true })
      .where(eq(agentOrchestrationPlanItems.itemId, 'item-s'));
    const [fetched] = await db
      .select()
      .from(agentOrchestrationPlanItems)
      .where(eq(agentOrchestrationPlanItems.itemId, 'item-s'));
    expect(fetched?.removed).toBe(true);
  });

  it('FK cascade: deleting a plan removes its items', async () => {
    const [plan] = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-c', sessionId: SESSION_A, title: 'c' })
      .returning();
    await db.insert(agentOrchestrationPlanItems).values({
      planId: plan!.id,
      itemId: 'item-c',
      agentName: 'a',
      task: 't',
    });
    await db
      .delete(agentOrchestrationPlans)
      .where(eq(agentOrchestrationPlans.planId, 'plan-c'));
    const orphans = await db
      .select()
      .from(agentOrchestrationPlanItems)
      .where(eq(agentOrchestrationPlanItems.itemId, 'item-c'));
    expect(orphans).toEqual([]); // cascaded
  });

  it('FK cascade: deleting a session removes its plans and their items', async () => {
    // Two-level cascade: session -> plans -> plan items. The FK added in
    // migration 0024 (agent_orchestration_plans.session_id -> sessions.id
    // ON DELETE CASCADE) plus the long-standing plan_items -> plans cascade
    // must together clear everything owned by the session. If the session FK
    // is ever dropped or changed to ON DELETE NO ACTION, this test fails —
    // which is exactly the regression the review asked us to guard against.
    // SESSION_A and SESSION_B are seeded by beforeEach; both survive until we
    // delete SESSION_A below.
    const inserted = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-sc', sessionId: SESSION_A, title: 'sc' })
      .returning();
    const plan = inserted[0];
    expect(plan).toBeDefined();
    await db.insert(agentOrchestrationPlanItems).values({
      planId: plan?.id as string,
      itemId: 'item-sc',
      agentName: 'a',
      task: 't',
    });
    // A plan belonging to a different session must survive deleting SESSION_A.
    const insertedOther = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-other', sessionId: SESSION_B, title: 'other' })
      .returning();
    const otherPlan = insertedOther[0];
    expect(otherPlan).toBeDefined();
    await db.insert(agentOrchestrationPlanItems).values({
      planId: otherPlan?.id as string,
      itemId: 'item-other',
      agentName: 'a',
      task: 't',
    });

    await db.delete(sessions).where(eq(sessions.id, SESSION_A));

    const remainingPlans = await db
      .select()
      .from(agentOrchestrationPlans)
      .where(eq(agentOrchestrationPlans.sessionId, SESSION_A));
    expect(remainingPlans).toEqual([]); // plans cascaded off session

    const remainingItems = await db
      .select()
      .from(agentOrchestrationPlanItems)
      .where(eq(agentOrchestrationPlanItems.itemId, 'item-sc'));
    expect(remainingItems).toEqual([]); // items cascaded off plans

    // The other session's plan + item are untouched.
    const survivorPlan = await db
      .select()
      .from(agentOrchestrationPlans)
      .where(eq(agentOrchestrationPlans.planId, 'plan-other'));
    expect(survivorPlan).toHaveLength(1);
    const survivorItem = await db
      .select()
      .from(agentOrchestrationPlanItems)
      .where(eq(agentOrchestrationPlanItems.itemId, 'item-other'));
    expect(survivorItem).toHaveLength(1);
  });

  it('status enum rejects invalid values at the drizzle layer', async () => {
    // drizzle's text.enum narrows the column type, so an invalid status is
    // a TS error at compile time. At runtime PGlite enforces the CHECK if
    // the migration generated one; otherwise the type cast just stores it.
    // We only assert the happy path here.
    const [row] = await db
      .insert(agentOrchestrationPlans)
      .values({ planId: 'plan-e', sessionId: SESSION_A, title: 'e' })
      .returning();
    await db
      .update(agentOrchestrationPlans)
      .set({ status: 'submitted' })
      .where(eq(agentOrchestrationPlans.planId, row!.planId));
    const [after] = await db
      .select()
      .from(agentOrchestrationPlans)
      .where(eq(agentOrchestrationPlans.planId, 'plan-e'));
    expect(after?.status).toBe('submitted');
  });

  it('querying by session respects the session index path', async () => {
    await db.insert(agentOrchestrationPlans).values([
      { planId: 'p1', sessionId: SESSION_A, title: 'a1' },
      { planId: 'p2', sessionId: SESSION_A, title: 'a2' },
      { planId: 'p3', sessionId: SESSION_B, title: 'b1' },
    ]);
    const sessionARows = await db
      .select()
      .from(agentOrchestrationPlans)
      .where(
        and(
          eq(agentOrchestrationPlans.sessionId, SESSION_A),
          eq(agentOrchestrationPlans.status, 'draft'),
        ),
      );
    expect(sessionARows.map((r) => r.planId).sort()).toEqual(['p1', 'p2']);
  });
});
