import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

/**
 * recordPlan tool (Team Mode III).
 *
 * Lets the Leader agent persist its fan-out decomposition decision into the
 * same `agent_orchestration_plans` table the manual plan editor (stage 2)
 * writes to. This closes the loop between stage 2 (user-authored plans) and
 * stage 3 (agent-authored plans): both surfaces feed the read-only graph
 * (stage 1), so a user can see — at a glance — which subtasks the agent
 * committed to, their dependencies, and (via the linked batches/jobs) their
 * live status.
 *
 * The tool ONLY records the plan; it does NOT spawn the subagents. The
 * Leader still uses the existing `subAgent` (spawn_async) tool to actually
 * fan out. Recording first means the plan is durable even if the agent
 * crashes before finishing the spawn wave, and gives the UI something to
 * render the moment the agent commits to a decomposition.
 */

const planItemSchema = z.object({
  agent: z
    .string()
    .min(1)
    .describe('Configured agent name for this subtask (e.g. "researcher").'),
  task: z
    .string()
    .min(1)
    .describe(
      'The subtask description verbatim (will be passed to the agent).',
    ),
  depends_on: z
    .array(z.string())
    .default([])
    .describe(
      'ItemIds (from the returned plan) this subtask depends on. Empty = ' +
        'runs in the first wave. Use the itemId strings this tool returns ' +
        'to wire dependencies between items you just recorded.',
    ),
});

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('Short human-readable title for the decomposition.'),
  goal: z
    .string()
    .optional()
    .describe('Optional one-paragraph description of the overall goal.'),
  items: z
    .array(planItemSchema)
    .min(1)
    .max(20)
    .describe('The subtasks. 1-20 items; order within a wave is preserved.'),
});

export default defineBuildInTool({
  id: 'record_plan',
  description:
    'Record a multi-agent decomposition plan (Team Leader mode). Persists ' +
    'the subtask breakdown so it shows up in the orchestration graph and ' +
    'survives crashes. Does NOT spawn the agents — follow up with subAgent ' +
    'spawn_async to actually execute. Call this BEFORE fanning out.',
  factory: async (_config, context) => {
    return {
      record_plan: tool({
        title: 'Record Decomposition Plan',
        description:
          'Persist a fan-out plan (title + items with agent/task/depends_on) ' +
          "to the orchestration table. Returns the planId and each item's " +
          'itemId so you can wire depends_on between them. Purely a record; ' +
          'you still need to call subAgent (spawn_async) to run the plan.',
        inputSchema,
        execute: async (input) => {
          const sessionId = context.sessionId;
          if (!sessionId) {
            return {
              ok: false,
              error: 'record_plan requires a session context',
            };
          }
          // Dynamic import keeps this module out of the workflow bundle's
          // static analysis graph (mirrors handoff/subAgent tool style).
          const { createPlan, addPlanItem, markPlanSubmitted } = await import(
            '@/lib/core/db/agent-orchestration-plans'
          );
          const plan = await createPlan({
            sessionId,
            title: input.title,
            description: input.goal,
          });
          // Insert items in input order; resolve depends_on after we know
          // every itemId. Because depends_on references itemIds we return,
          // the agent typically calls record_plan twice: once to seed items
          // (no deps), then again — but the simpler contract is: caller
          // passes deps as 1-based wave indices or leaves them empty and
          // relies on spawn_async wave sequencing. We honor any string ids
          // given verbatim.
          const created: { itemId: string; agent: string; task: string }[] = [];
          for (const item of input.items) {
            const row = await addPlanItem({
              planId: plan.planId,
              agentName: item.agent,
              task: item.task,
              dependsOn: item.depends_on,
            });
            created.push({
              itemId: row.itemId,
              agent: item.agent,
              task: item.task,
            });
          }
          // Mark submitted — the agent is about to spawn; this moves the
          // plan out of 'draft' so it doesn't clutter the manual editor.
          await markPlanSubmitted(plan.planId, '');
          return {
            ok: true,
            planId: plan.planId,
            items: created,
            note: 'Plan recorded. Now call subAgent (action: spawn_async) per wave to execute it.',
          };
        },
      }),
    };
  },
});
