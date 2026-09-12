/**
 * Orchestration plan DAG validation.
 *
 * `computeWaves()` in agent-orchestration-plans.ts deliberately tolerates
 * malformed DAGs (cycles get flattened into one late wave so an LLM-authored
 * plan still runs). That tolerance is the right LAST line of defense, but it
 * left the user-facing editor with no feedback: a typo'd dependency or an
 * accidental cycle silently degraded execution. This module is the FIRST
 * line of defense — a pure validator shared by the web editor (live
 * feedback), the web submit action, and the CLI submit route.
 *
 * Kahn-algorithm cycle detection and typed issue codes follow the pattern of
 * ref/piwork's workflow-schema validator (see
 * ref/piwork/packages/shared/src/workflow-schema.ts).
 */

/** Structural subset of AgentOrchestrationPlanItem — no schema import so this
 *  module stays client-safe (the editor imports it in a client component). */
export interface PlanDagItem {
  itemId: string;
  dependsOn: string[];
}

export type PlanDagIssueCode =
  | 'EMPTY'
  | 'DUPLICATE_ITEM'
  | 'SELF_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'BLOCKED_BY_CYCLE';

export interface PlanDagIssue {
  code: PlanDagIssueCode;
  message: string;
  itemId?: string;
  dependsOnItemId?: string;
}

export function validatePlanDag(items: PlanDagItem[]): PlanDagIssue[] {
  const issues: PlanDagIssue[] = [];
  if (items.length === 0) {
    return [{ code: 'EMPTY', message: '规划中没有任何任务项。' }];
  }

  // Uniqueness (defensive: the DB constrains this, but editor state can race).
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.itemId)) {
      issues.push({
        code: 'DUPLICATE_ITEM',
        itemId: item.itemId,
        message: `任务项 ID 重复:${item.itemId}`,
      });
    }
    seen.add(item.itemId);
  }

  // Per-edge checks: self deps and unknown targets.
  for (const item of items) {
    const deps = new Set(item.dependsOn);
    for (const dep of deps) {
      if (dep === item.itemId) {
        issues.push({
          code: 'SELF_DEPENDENCY',
          itemId: item.itemId,
          message: `任务 ${item.itemId} 依赖它自己。`,
        });
      } else if (!seen.has(dep)) {
        issues.push({
          code: 'UNKNOWN_DEPENDENCY',
          itemId: item.itemId,
          dependsOnItemId: dep,
          message: `任务 ${item.itemId} 依赖不存在的任务 ${dep}(检查 itemId 拼写,或先创建该任务)。`,
        });
      }
    }
  }

  // Kahn's algorithm over edges that reference existing, non-self targets.
  // Leftover nodes either sit on a cycle or are stuck behind one.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of items) {
    indegree.set(item.itemId, 0);
  }
  const edgesOf = new Map<string, Set<string>>();
  for (const item of items) {
    const valid = new Set(
      item.dependsOn.filter((dep) => dep !== item.itemId && seen.has(dep)),
    );
    edgesOf.set(item.itemId, valid);
    for (const dep of valid) {
      indegree.set(item.itemId, (indegree.get(item.itemId) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(item.itemId);
      dependents.set(dep, list);
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const placed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    placed.add(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (placed.size < items.length) {
    const leftover = items.filter((item) => !placed.has(item.itemId));
    // A leftover node is ON a cycle iff it can reach itself by following
    // "depends on" edges within the leftover set (SCC membership); nodes
    // merely downstream of a cycle are blocked, not cyclic.
    const leftoverIds = new Set(leftover.map((i) => i.itemId));
    const onCycle = (start: string): boolean => {
      const stack = [...(edgesOf.get(start) ?? [])].filter((id) =>
        leftoverIds.has(id),
      );
      const visited = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (current === start) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const dep of edgesOf.get(current) ?? []) {
          if (leftoverIds.has(dep)) stack.push(dep);
        }
      }
      return false;
    };
    const cyclic = leftover.filter((item) => onCycle(item.itemId));
    const blocked = leftover.filter((item) => !cyclic.includes(item));
    if (cyclic.length > 0) {
      issues.push({
        code: 'CYCLE',
        message: `依赖成环,环内任务:${cyclic.map((i) => i.itemId).join('、')}(必须移除至少一条环内依赖)。`,
      });
    }
    if (blocked.length > 0) {
      issues.push({
        code: 'BLOCKED_BY_CYCLE',
        message: `以下任务被环阻塞,永远无法执行:${blocked.map((i) => i.itemId).join('、')}`,
      });
    }
  }

  return issues;
}

export function formatPlanDagIssues(issues: PlanDagIssue[]): string {
  return issues.map((issue) => issue.message).join('\n');
}

/** Hard gate for submit paths: throws with every issue listed. */
export function assertPlanDagValid(items: PlanDagItem[]): void {
  const issues = validatePlanDag(items);
  if (issues.length > 0) {
    throw new Error(
      `规划校验未通过,请修正后重试:\n${formatPlanDagIssues(issues)}`,
    );
  }
}
