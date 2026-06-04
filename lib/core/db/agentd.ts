import { and, desc, eq, like, } from 'drizzle-orm';
import { db } from './index';
import {
  agentL0Rules,
  agentMemories,
  agentReviewLogs,
  agentSandboxes,
  agentTaskOutputs,
  agentTasks,
  archivedTaskSummaries,
  taskSummaries,
  workspaces,
} from './schema';
import type { Decision } from './schema';

// === Tasks ===

export async function createTask(data: {
  id?: string;
  agentId: string;
  sessionId?: string;
  command: string;
  sandboxType?: string;
  sandboxId?: string;
  env?: Record<string, string>;
  timeout?: number;
}) {
  const [task] = await db
    .insert(agentTasks)
    .values({
      agentId: data.agentId,
      sessionId: data.sessionId ?? null,
      command: data.command,
      sandboxType: data.sandboxType ?? 'auto',
      sandboxId: data.sandboxId ?? null,
      env: data.env ?? null,
      timeout: data.timeout ?? 300,
      status: 'pending',
    })
    .returning();
  return task;
}

export async function getTask(id: string) {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, id));
  return task ?? null;
}

export async function updateTaskStatus(
  id: string,
  status: string,
  result?: string,
) {
  const [task] = await db
    .update(agentTasks)
    .set({
      status: status as (typeof agentTasks.status.enumValues)[number],
      result: result ?? null,
    })
    .where(eq(agentTasks.id, id))
    .returning();
  return task;
}

export async function listTasks(agentId: string, limit = 50) {
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.agentId, agentId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit);
}

// === Review Logs ===

export async function writeReviewLogs(
  logs: Array<{
    taskId: string;
    command: string;
    level: string;
    score?: number;
    decision: string;
    reason?: string;
  }>,
) {
  return db
    .insert(agentReviewLogs)
    .values(
      logs.map((log) => ({
        taskId: log.taskId,
        command: log.command,
        level: log.level as 'L0' | 'L1' | 'L2',
        score: log.score ?? null,
        decision: log.decision as 'allowed' | 'blocked' | 'pending_confirm',
        reason: log.reason ?? null,
      })),
    )
    .returning();
}

export async function getReviewLogs(taskId: string) {
  return db
    .select()
    .from(agentReviewLogs)
    .where(eq(agentReviewLogs.taskId, taskId))
    .orderBy(desc(agentReviewLogs.createdAt));
}

// === L0 Rules ===

export async function getL0Rules(agentId: string) {
  return db
    .select()
    .from(agentL0Rules)
    .where(
      and(eq(agentL0Rules.enabled, true), eq(agentL0Rules.agentId, agentId)),
    );
}

export async function listL0Rules() {
  return db.select().from(agentL0Rules).orderBy(desc(agentL0Rules.createdAt));
}

export async function createL0Rule(data: {
  agentId?: string;
  pattern: string;
  type: string;
  action: string;
  scope?: string;
}) {
  const [rule] = await db
    .insert(agentL0Rules)
    .values({
      agentId: data.agentId ?? 'global',
      pattern: data.pattern,
      type: data.type as 'command' | 'path' | 'network',
      action: data.action as 'block' | 'warn',
      scope: (data.scope ?? 'global') as 'workspace' | 'global',
    })
    .returning();
  return rule;
}

export async function updateL0Rule(id: string, data: Record<string, unknown>) {
  const [rule] = await db
    .update(agentL0Rules)
    .set(data)
    .where(eq(agentL0Rules.id, id))
    .returning();
  return rule;
}

export async function deleteL0Rule(id: string) {
  await db.delete(agentL0Rules).where(eq(agentL0Rules.id, id));
}

// === Sandboxes ===

export async function registerSandbox(data: {
  agentId: string;
  type: string;
  path?: string;
  persistent?: boolean;
}) {
  const [sb] = await db
    .insert(agentSandboxes)
    .values({
      agentId: data.agentId,
      type: data.type as 'tmpfs' | 'chroot' | 'docker',
      path: data.path ?? null,
      status: 'creating',
      persistent: data.persistent ?? false,
    })
    .returning();
  return sb;
}

export async function updateSandboxStatus(id: string, status: string) {
  const [sb] = await db
    .update(agentSandboxes)
    .set({ status: status as 'creating' | 'ready' | 'destroyed' })
    .where(eq(agentSandboxes.id, id))
    .returning();
  return sb;
}

export async function getSandbox(id: string) {
  const [sb] = await db
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, id));
  return sb ?? null;
}

// === Memories ===

export async function getMemories(
  agentId: string,
  keywords: string[] = [],
  limit = 10,
) {
  let query = db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.createdAt))
    .limit(limit);

  if (keywords.length > 0) {
    const conditions = keywords.map((k) => like(agentMemories.key, `%${k}%`));
    query = db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), ...conditions))
      .orderBy(desc(agentMemories.createdAt))
      .limit(limit);
  }

  return query;
}

export async function writeMemories(
  memories: Array<{
    agentId: string;
    key: string;
    value: string;
    source?: string;
  }>,
) {
  return db
    .insert(agentMemories)
    .values(
      memories.map((m) => ({
        agentId: m.agentId,
        key: m.key,
        value: m.value,
        source: m.source ?? null,
      })),
    )
    .returning();
}

export async function deleteMemory(id: string) {
  await db.delete(agentMemories).where(eq(agentMemories.id, id));
}

// === Task Outputs (Streaming) ===

export async function upsertAgentTaskOutput(data: {
  taskID: string;
  sessionID: string;
  output: string;
  streamPosition: number;
}) {
  const [record] = await db
    .insert(agentTaskOutputs)
    .values({
      taskId: data.taskID,
      sessionId: data.sessionID,
      output: data.output,
      streamPosition: data.streamPosition,
    })
    .returning();
  return record;
}

// === Agent Config ===

export async function getAgentConfig(agentId: string) {
  const rules = await getL0Rules(agentId);
  return {
    agentId,
    l0Rules: rules.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      type: r.type,
      action: r.action,
      scope: r.scope,
    })),
  };
}

// === Task Summaries ===

export interface TaskSummaryRecord {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;
  status: 'active' | 'paused' | 'completed';
  progress: string | null;
  decisions: Decision[] | null;
  pending: string[] | null;
  knownIssues: string[] | null;
  version: number;
  lastUpdated: Date;
  createdAt: Date;
}

export async function getTaskSummary(
  taskId: string,
): Promise<TaskSummaryRecord | null> {
  const [row] = await db
    .select()
    .from(taskSummaries)
    .where(
      and(eq(taskSummaries.taskId, taskId), eq(taskSummaries.isCurrent, true)),
    );
  return row ?? null;
}

export async function upsertTaskSummary(data: {
  taskId: string;
  agentId: string;
  sessionId?: string;
  status?: 'active' | 'paused' | 'completed';
  progress?: string;
  decisions?: Decision[];
  pending?: string[];
  knownIssues?: string[];
}): Promise<TaskSummaryRecord> {
  // Check if a current version exists for this task
  const [existing] = await db
    .select()
    .from(taskSummaries)
    .where(
      and(eq(taskSummaries.taskId, data.taskId), eq(taskSummaries.isCurrent, true)),
    );

  if (existing) {
    // Mark current version as not current
    await db
      .update(taskSummaries)
      .set({ isCurrent: false })
      .where(eq(taskSummaries.id, existing.id));

    // Insert new version
    const [record] = await db
      .insert(taskSummaries)
      .values({
        taskId: data.taskId,
        agentId: data.agentId,
        sessionId: data.sessionId ?? existing.sessionId ?? null,
        status: data.status ?? existing.status,
        progress: data.progress ?? existing.progress,
        decisions: data.decisions ?? existing.decisions,
        pending: data.pending ?? existing.pending,
        knownIssues: data.knownIssues ?? existing.knownIssues,
        version: existing.version + 1,
        isCurrent: true,
      })
      .returning();
    return record;
  }

  // No existing version — insert first version
  const [record] = await db
    .insert(taskSummaries)
    .values({
      taskId: data.taskId,
      agentId: data.agentId,
      sessionId: data.sessionId ?? null,
      status: data.status ?? 'active',
      progress: data.progress ?? null,
      decisions: data.decisions ?? null,
      pending: data.pending ?? null,
      knownIssues: data.knownIssues ?? null,
      version: 1,
      isCurrent: true,
    })
    .returning();
  return record;
}

export async function getTaskSummaryHistory(
  taskId: string,
): Promise<TaskSummaryRecord[]> {
  return db
    .select()
    .from(taskSummaries)
    .where(eq(taskSummaries.taskId, taskId))
    .orderBy(desc(taskSummaries.version));
}

export async function archiveTaskSummary(taskId: string): Promise<boolean> {
  const history = await getTaskSummaryHistory(taskId);
  if (history.length === 0) {
    return false;
  }

  // Move all versions to archive
  await db.insert(archivedTaskSummaries).values(
    history.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      agentId: row.agentId,
      sessionId: row.sessionId,
      status: row.status,
      progress: row.progress,
      decisions: row.decisions,
      pending: row.pending,
      knownIssues: row.knownIssues,
      version: row.version,
      lastUpdated: row.lastUpdated,
      createdAt: row.createdAt,
    })),
  );

  // Delete from active table
  await db.delete(taskSummaries).where(eq(taskSummaries.taskId, taskId));

  return true;
}

export async function listActiveTaskSummaries(
  agentId: string,
): Promise<TaskSummaryRecord[]> {
  return db
    .select()
    .from(taskSummaries)
    .where(
      and(
        eq(taskSummaries.agentId, agentId),
        eq(taskSummaries.status, 'active'),
        eq(taskSummaries.isCurrent, true),
      ),
    )
    .orderBy(desc(taskSummaries.lastUpdated));
}

// === Workspaces ===

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  agentId: string;
  name: string | null;
  sandboxId: string;
  sandboxType: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export async function createWorkspace(data: {
  projectId: string;
  agentId: string;
  name?: string;
  sandboxId: string;
  sandboxType: string;
}): Promise<WorkspaceRecord> {
  const [row] = await db
    .insert(workspaces)
    .values({
      projectId: data.projectId,
      agentId: data.agentId,
      name: data.name ?? null,
      sandboxId: data.sandboxId,
      sandboxType: data.sandboxType,
      status: 'active',
    })
    .returning();
  return row;
}

export async function getWorkspace(
  id: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return row ?? null;
}

export async function getWorkspaceByProjectId(
  projectId: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId));
  return row ?? null;
}

export async function listWorkspaces(
  agentId: string,
): Promise<WorkspaceRecord[]> {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.agentId, agentId))
    .orderBy(desc(workspaces.updatedAt));
}

export async function archiveWorkspace(
  id: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .update(workspaces)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(workspaces.id, id))
    .returning();
  return row ?? null;
}
