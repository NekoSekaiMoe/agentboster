/**
 * DB layer for agent_orchestration_plans + agent_orchestration_plan_items.
 *
 * Team Mode II (manual planning entry). Plans are user-authored lists of
 * (agent, task, depends_on) tuples; submitting a plan synthesizes an
 * instruction message for the main agent that fans the plan out via the
 * existing subAgent spawn tool. See schema file for the data model.
 */
import { and, asc, eq } from 'drizzle-orm';
import { db } from './index';
import {
  agentOrchestrationPlanItems,
  agentOrchestrationPlans,
  type AgentOrchestrationPlan,
  type AgentOrchestrationPlanItem,
} from './schema';

function generatePlanId(): string {
  return `plan-${Math.random().toString(36).slice(2, 10)}`;
}

function generateItemId(): string {
  return `item-${Math.random().toString(36).slice(2, 10)}`;
}

export interface PlanWithItems extends AgentOrchestrationPlan {
  items: AgentOrchestrationPlanItem[];
}

export async function createPlan(input: {
  sessionId: string;
  title: string;
  description?: string | null;
}): Promise<AgentOrchestrationPlan> {
  const [row] = await db
    .insert(agentOrchestrationPlans)
    .values({
      planId: generatePlanId(),
      sessionId: input.sessionId,
      title: input.title,
      description: input.description ?? null,
    })
    .returning();
  if (!row) throw new Error('createPlan: insert returned no row');
  return row;
}

export async function getPlan(planId: string): Promise<PlanWithItems | null> {
  const [plan] = await db
    .select()
    .from(agentOrchestrationPlans)
    .where(eq(agentOrchestrationPlans.planId, planId))
    .limit(1);
  if (!plan) return null;
  const items = await db
    .select()
    .from(agentOrchestrationPlanItems)
    .where(
      and(
        eq(agentOrchestrationPlanItems.planId, plan.id),
        eq(agentOrchestrationPlanItems.removed, false),
      ),
    )
    .orderBy(
      asc(agentOrchestrationPlanItems.order),
      asc(agentOrchestrationPlanItems.createdAt),
    );
  return { ...plan, items };
}

export async function listPlansBySession(
  sessionId: string,
): Promise<AgentOrchestrationPlan[]> {
  return db
    .select()
    .from(agentOrchestrationPlans)
    .where(
      and(
        eq(agentOrchestrationPlans.sessionId, sessionId),
        eq(agentOrchestrationPlans.status, 'draft'),
      ),
    )
    .orderBy(asc(agentOrchestrationPlans.createdAt));
}

export async function addPlanItem(input: {
  planId: string;
  agentName: string;
  task: string;
  dependsOn?: string[];
  order?: number;
}): Promise<AgentOrchestrationPlanItem> {
  // planId here is the stable plan_id (text), resolve to the uuid PK.
  const [plan] = await db
    .select({ id: agentOrchestrationPlans.id })
    .from(agentOrchestrationPlans)
    .where(eq(agentOrchestrationPlans.planId, input.planId))
    .limit(1);
  if (!plan) throw new Error(`plan ${input.planId} not found`);
  const [row] = await db
    .insert(agentOrchestrationPlanItems)
    .values({
      planId: plan.id,
      itemId: generateItemId(),
      agentName: input.agentName,
      task: input.task,
      dependsOn: input.dependsOn ?? [],
      order: input.order ?? 0,
    })
    .returning();
  if (!row) throw new Error('addPlanItem: insert returned no row');
  return row;
}

export async function updatePlanItem(
  itemId: string,
  patch: Partial<
    Pick<
      AgentOrchestrationPlanItem,
      'agentName' | 'task' | 'dependsOn' | 'order'
    >
  >,
): Promise<AgentOrchestrationPlanItem | null> {
  const [row] = await db
    .update(agentOrchestrationPlanItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agentOrchestrationPlanItems.itemId, itemId))
    .returning();
  return row ?? null;
}

export async function removePlanItem(itemId: string): Promise<void> {
  await db
    .update(agentOrchestrationPlanItems)
    .set({ removed: true, updatedAt: new Date() })
    .where(eq(agentOrchestrationPlanItems.itemId, itemId));
}

export async function markPlanSubmitted(
  planId: string,
  submittedMessageId: string,
): Promise<AgentOrchestrationPlan | null> {
  const [row] = await db
    .update(agentOrchestrationPlans)
    .set({
      status: 'submitted',
      submittedMessageId,
      updatedAt: new Date(),
    })
    .where(eq(agentOrchestrationPlans.planId, planId))
    .returning();
  return row ?? null;
}

export async function archivePlan(planId: string): Promise<void> {
  await db
    .update(agentOrchestrationPlans)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(agentOrchestrationPlans.planId, planId));
}

export async function updatePlan(
  planId: string,
  patch: Partial<
    Pick<AgentOrchestrationPlan, 'title' | 'description' | 'status'>
  >,
): Promise<AgentOrchestrationPlan | null> {
  const [row] = await db
    .update(agentOrchestrationPlans)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agentOrchestrationPlans.planId, planId))
    .returning();
  return row ?? null;
}

/**
 * Ownership helper: resolve a plan and verify it belongs to the given
 * session. Throws on mismatch. Used by server actions that receive a bare
 * planId and need to enforce session-level ownership.
 */
export async function assertCanAccessPlan(
  planId: string,
  sessionId: string,
): Promise<void> {
  const [row] = await db
    .select({ sessionId: agentOrchestrationPlans.sessionId })
    .from(agentOrchestrationPlans)
    .where(eq(agentOrchestrationPlans.planId, planId))
    .limit(1);
  if (!row || row.sessionId !== sessionId) {
    throw new Error(`plan ${planId} not accessible for session ${sessionId}`);
  }
}

/**
 * Translate a plan into the instruction text the main agent receives on
 * submission. The agent is told to fan the plan out via its existing
 * subAgent spawn tool, respecting depends_on by sequencing waves.
 *
 * This is deliberately a natural-language prompt (not a direct tool call)
 * so the main agent retains authority to adapt — refuse an item, merge
 * waves, ask for clarification — instead of blindly executing user input.
 */
export function synthesizePlanInstruction(plan: PlanWithItems): string {
  const waves = computeWaves(plan.items);
  const lines: string[] = [];
  lines.push(`# 用户规划的多智能体执行计划: ${plan.title}`);
  if (plan.description) lines.push(plan.description);
  lines.push('');
  lines.push(
    '请按以下规划，使用 subAgent 工具 (action: spawn 或 spawn_async) 把任务派发给对应 agent。依赖关系通过 wave 体现，同一 wave 内可并行，跨 wave 必须等待前一波完成。',
  );
  waves.forEach((wave, idx) => {
    lines.push('');
    lines.push(`## Wave ${idx + 1}`);
    for (const item of wave) {
      lines.push(
        `- agent: \`${item.agentName}\` | 任务: ${item.task}${
          item.dependsOn.length > 0
            ? ` | 依赖: ${item.dependsOn.join(', ')}`
            : ''
        }`,
      );
    }
  });
  lines.push('');
  lines.push(
    '全部完成后请汇总每个子 agent 的结果。如某项不合理或可优化，可在执行前提出建议。',
  );
  return lines.join('\n');
}

/**
 * Compute topological waves from depends_on. Items with no deps go in wave 0;
 * items whose deps are all in earlier waves go in the next wave. Raises no
 * errors on cycles — a cycle just puts both items in the same late wave,
 * which the agent can still attempt. Deterministic order within a wave by
 * the item's `order` field.
 */
export function computeWaves(
  items: AgentOrchestrationPlanItem[],
): AgentOrchestrationPlanItem[][] {
  const remaining = new Map(items.map((i) => [i.itemId, i]));
  const placed = new Set<string>();
  const waves: AgentOrchestrationPlanItem[][] = [];
  const maxIterations = items.length + 1;
  let iter = 0;
  while (remaining.size > 0 && iter < maxIterations) {
    iter += 1;
    const currentWave: AgentOrchestrationPlanItem[] = [];
    for (const [id, item] of remaining) {
      const ready =
        item.dependsOn.length === 0 ||
        item.dependsOn.every((dep) => placed.has(dep));
      if (ready) currentWave.push(item);
    }
    if (currentWave.length === 0) {
      // Cycle: dump everything remaining into this wave rather than loop.
      for (const item of remaining.values()) currentWave.push(item);
    }
    currentWave.sort((a, b) => a.order - b.order);
    for (const item of currentWave) {
      placed.add(item.itemId);
      remaining.delete(item.itemId);
    }
    waves.push(currentWave);
  }
  return waves;
}
