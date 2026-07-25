import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * agentOrchestrationPlans + agentOrchestrationPlanItems: user-authored
 * multi-agent execution plans (Team Mode II).
 *
 * Stage 1 of team mode (read-only graph, batch #6) only visualized the
 * batches/barriers/handoffs the agent had already created on its own.
 * Stage 2 lets the USER author a plan in the UI — list the subtasks and
 * which configured agent should handle each — then submit it as an
 * instruction to the main agent, which fans it out via the existing
 * subAgent spawn tool. The plan is persisted so it can be revisited,
 * edited, and re-run.
 *
 * Plan -> items is one-to-many. An item carries the agent name + task
 * description + optional depends_on (another item's id) for ordered
 * fan-out. Status mirrors the subAgent batch lifecycle so the read-only
 * graph can overlay plan items on top of live batches.
 */

export const agentOrchestrationPlans = pgTable(
  'agent_orchestration_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Stable id for URL/API references (plan_xxx). */
    planId: text('plan_id').notNull().unique(),
    sessionId: uuid('session_id').notNull(),
    title: text('title').notNull(),
    /** Optional user note describing the overall goal. */
    description: text('description'),
    /**
     * 'draft'    : editable, not yet submitted.
     * 'submitted': converted to an instruction injected into the chat.
     * 'archived' : soft-deleted / superseded.
     */
    status: text('status', {
      enum: ['draft', 'submitted', 'archived'],
    })
      .default('draft')
      .notNull(),
    /**
     * When the plan is submitted, the chat message id that carried the
     * synthesized instruction is recorded here so the UI can deep-link.
     */
    submittedMessageId: text('submitted_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('agent_orchestration_plans_session_idx').on(table.sessionId),
    index('agent_orchestration_plans_status_idx').on(table.status),
    // The text `enum` above only constrains TypeScript; the column is plain
    // text at the DB level. Enforce the allowed status set with a CHECK so
    // an invalid status can never be persisted (mirrors memory_edges.relation).
    check(
      'agent_orchestration_plans_status_check',
      sql`${table.status} IN ('draft', 'submitted', 'archived')`,
    ),
  ],
);

export const agentOrchestrationPlanItems = pgTable(
  'agent_orchestration_plan_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => agentOrchestrationPlans.id, {
        onDelete: 'cascade',
      }),
    /** Stable per-item id for depends_on references. */
    itemId: text('item_id').notNull().unique(),
    /** Which configured agent should handle this subtask. */
    agentName: text('agent_name').notNull(),
    /** The task description verbatim (passed to the subAgent). */
    task: text('task').notNull(),
    /**
     * Ordered list of itemId strings this item depends on. Empty = run in
     * the first fan-out wave. Lets the user express a DAG without writing
     * code; the submission step translates waves into sequential subAgent
     * spawn calls separated by barriers.
     */
    dependsOn: jsonb('depends_on').$type<string[]>().default([]).notNull(),
    /** Soft ordering within a wave (lower runs first). */
    order: integer('order').default(0).notNull(),
    /** Marks the item as removed in the UI without hard delete. */
    removed: boolean('removed').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('agent_orchestration_plan_items_plan_idx').on(table.planId),
    index('agent_orchestration_plan_items_item_idx').on(table.itemId),
  ],
);

export type AgentOrchestrationPlan =
  typeof agentOrchestrationPlans.$inferSelect;
export type NewAgentOrchestrationPlan =
  typeof agentOrchestrationPlans.$inferInsert;
export type AgentOrchestrationPlanItem =
  typeof agentOrchestrationPlanItems.$inferSelect;
export type NewAgentOrchestrationPlanItem =
  typeof agentOrchestrationPlanItems.$inferInsert;
