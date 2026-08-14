import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  max,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { db } from '@/lib/core/db';
import {
  agentReviewLogs,
  agentTasks,
  agentToolActivityLogs,
  messages,
  sessions,
} from '@/lib/core/db/schema';
import { getSessionRuntimeMetadata } from '@/lib/core/sandbox/runtime';

import {
  buildTraceDetail,
  buildTraceSummary,
  mergeTraceRows,
  type TraceDetail,
  type TraceModelRow,
  type TraceReviewRow,
  type TraceRows,
  type TraceStatusHint,
  type TraceSummary,
  type TraceToolRow,
} from './aggregate';

export interface TraceQueryScope {
  userId?: string;
}

export interface TraceListOptions {
  limit?: number;
  search?: string;
}

interface TraceCandidate {
  traceId: string;
  occurredAt: Date;
}

function scopeCondition(
  column: typeof sessions.userId,
  scope: TraceQueryScope,
) {
  return scope.userId ? eq(column, scope.userId) : undefined;
}

function compactLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit ?? 100), 1), 250);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function traceIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.metadata)) return null;
  return typeof payload.metadata.runId === 'string'
    ? payload.metadata.runId
    : null;
}

function hintFromSession(input: {
  workflowRunId: string | null;
  metadata: Record<string, unknown> | null;
}): TraceStatusHint {
  const runtime = getSessionRuntimeMetadata(input.metadata);
  return {
    currentRunId: input.workflowRunId,
    lastRunId: runtime.workflow.lastRunId,
    phase: runtime.workflow.phase,
    stoppedAt: runtime.workflow.stoppedAt,
    lastError: runtime.workflow.lastError,
  };
}

function latestCandidates(
  candidates: TraceCandidate[],
  limit: number,
): string[] {
  const latestByTrace = new Map<string, number>();
  for (const candidate of candidates) {
    const occurredAt = candidate.occurredAt.getTime();
    latestByTrace.set(
      candidate.traceId,
      Math.max(latestByTrace.get(candidate.traceId) ?? 0, occurredAt),
    );
  }
  return [...latestByTrace.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([traceId]) => traceId);
}

async function listCandidateTraceIds(
  scope: TraceQueryScope,
  options: TraceListOptions,
): Promise<string[]> {
  const candidateLimit = compactLimit(options.limit) * 4;
  const search = options.search?.trim();
  const traceIdExpression = sql<string>`${messages.payload}->'metadata'->>'runId'`;
  const modelConditions: SQL[] = [
    sql`${messages.payload}->'metadata'->>'runId' IS NOT NULL`,
  ];
  const modelScope = scopeCondition(sessions.userId, scope);
  if (modelScope) modelConditions.push(modelScope);

  const toolConditions: SQL[] = [isNotNull(agentToolActivityLogs.traceId)];
  if (scope.userId) {
    toolConditions.push(eq(agentToolActivityLogs.userId, scope.userId));
  }

  const reviewConditions: SQL[] = [isNotNull(agentReviewLogs.traceId)];
  if (scope.userId) {
    reviewConditions.push(eq(agentReviewLogs.userId, scope.userId));
  }
  if (search) {
    const pattern = `%${search}%`;
    modelConditions.push(
      or(
        sql`${traceIdExpression} ILIKE ${pattern}`,
        ilike(sessions.title, pattern),
      ) as SQL,
    );
    toolConditions.push(ilike(agentToolActivityLogs.traceId, pattern));
    reviewConditions.push(ilike(agentReviewLogs.traceId, pattern));
  }

  const [modelRows, toolRows, reviewRows] = await Promise.all([
    db
      .select({
        traceId: traceIdExpression,
        occurredAt: max(messages.createdAt),
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(...modelConditions))
      .groupBy(traceIdExpression)
      .orderBy(desc(max(messages.createdAt)))
      .limit(candidateLimit),
    db
      .select({
        traceId: agentToolActivityLogs.traceId,
        occurredAt: max(agentToolActivityLogs.startedAt),
      })
      .from(agentToolActivityLogs)
      .where(and(...toolConditions))
      .groupBy(agentToolActivityLogs.traceId)
      .orderBy(desc(max(agentToolActivityLogs.startedAt)))
      .limit(candidateLimit),
    db
      .select({
        traceId: agentReviewLogs.traceId,
        occurredAt: max(agentReviewLogs.createdAt),
      })
      .from(agentReviewLogs)
      .where(and(...reviewConditions))
      .groupBy(agentReviewLogs.traceId)
      .orderBy(desc(max(agentReviewLogs.createdAt)))
      .limit(candidateLimit),
  ]);

  return latestCandidates(
    [
      ...modelRows.flatMap((row) =>
        row.traceId && row.occurredAt
          ? [{ traceId: row.traceId, occurredAt: row.occurredAt }]
          : [],
      ),
      ...toolRows.flatMap((row) =>
        row.traceId && row.occurredAt
          ? [{ traceId: row.traceId, occurredAt: row.occurredAt }]
          : [],
      ),
      ...reviewRows.flatMap((row) =>
        row.traceId && row.occurredAt
          ? [{ traceId: row.traceId, occurredAt: row.occurredAt }]
          : [],
      ),
    ],
    compactLimit(options.limit),
  );
}

async function loadModelRows(
  traceIds: string[],
  scope: TraceQueryScope,
): Promise<TraceModelRow[]> {
  if (traceIds.length === 0) return [];
  const conditions: SQL[] = [
    inArray(sql<string>`${messages.payload}->'metadata'->>'runId'`, traceIds),
  ];
  const scoped = scopeCondition(sessions.userId, scope);
  if (scoped) conditions.push(scoped);

  const rows = await db
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      sessionTitle: sessions.title,
      userId: sessions.userId,
      role: messages.role,
      stepNumber: messages.stepNumber,
      payload: messages.payload,
      createdAt: messages.createdAt,
      workflowRunId: sessions.workflowRunId,
      sessionMetadata: sessions.metadata,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(asc(messages.createdAt));

  return rows.flatMap((row) => {
    const traceId = traceIdFromPayload(row.payload);
    if (!traceId) return [];
    return [
      {
        id: row.id,
        traceId,
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        userId: row.userId,
        role: row.role,
        stepNumber: row.stepNumber,
        payload: row.payload,
        createdAt: row.createdAt,
        hint: hintFromSession({
          workflowRunId: row.workflowRunId,
          metadata: row.sessionMetadata,
        }),
      } satisfies TraceModelRow,
    ];
  });
}

async function loadToolRows(
  traceIds: string[],
  scope: TraceQueryScope,
): Promise<TraceToolRow[]> {
  if (traceIds.length === 0) return [];
  const conditions: SQL[] = [inArray(agentToolActivityLogs.traceId, traceIds)];
  if (scope.userId) {
    conditions.push(eq(agentToolActivityLogs.userId, scope.userId));
  }

  const rows = await db
    .select({
      id: agentToolActivityLogs.id,
      traceId: agentToolActivityLogs.traceId,
      sessionId: agentToolActivityLogs.sessionId,
      sessionTitle: sessions.title,
      userId: agentToolActivityLogs.userId,
      agentId: agentToolActivityLogs.agentId,
      toolName: agentToolActivityLogs.toolName,
      action: agentToolActivityLogs.action,
      target: agentToolActivityLogs.target,
      arguments: agentToolActivityLogs.arguments,
      result: agentToolActivityLogs.result,
      outputText: agentToolActivityLogs.outputText,
      success: agentToolActivityLogs.success,
      error: agentToolActivityLogs.error,
      durationMs: agentToolActivityLogs.durationMs,
      startedAt: agentToolActivityLogs.startedAt,
      completedAt: agentToolActivityLogs.completedAt,
      workflowRunId: sessions.workflowRunId,
      sessionMetadata: sessions.metadata,
    })
    .from(agentToolActivityLogs)
    .leftJoin(sessions, eq(agentToolActivityLogs.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(asc(agentToolActivityLogs.startedAt));

  return rows.flatMap((row) =>
    row.traceId
      ? [
          {
            ...row,
            traceId: row.traceId,
            hint: hintFromSession({
              workflowRunId: row.workflowRunId,
              metadata: row.sessionMetadata,
            }),
          } satisfies TraceToolRow,
        ]
      : [],
  );
}

async function loadReviewRows(
  traceIds: string[],
  scope: TraceQueryScope,
): Promise<TraceReviewRow[]> {
  if (traceIds.length === 0) return [];
  const conditions: SQL[] = [inArray(agentReviewLogs.traceId, traceIds)];
  if (scope.userId) {
    conditions.push(eq(agentReviewLogs.userId, scope.userId));
  }

  const rows = await db
    .select({
      id: agentReviewLogs.id,
      traceId: agentReviewLogs.traceId,
      taskId: agentReviewLogs.taskId,
      sessionId: agentTasks.sessionId,
      sessionTitle: sessions.title,
      userId: agentReviewLogs.userId,
      agentId: agentTasks.agentId,
      level: agentReviewLogs.level,
      decision: agentReviewLogs.decision,
      score: agentReviewLogs.score,
      command: agentReviewLogs.command,
      reason: agentReviewLogs.reason,
      createdAt: agentReviewLogs.createdAt,
      workflowRunId: sessions.workflowRunId,
      sessionMetadata: sessions.metadata,
    })
    .from(agentReviewLogs)
    .leftJoin(agentTasks, eq(agentReviewLogs.taskId, agentTasks.id))
    .leftJoin(sessions, eq(agentTasks.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(asc(agentReviewLogs.createdAt));

  return rows.flatMap((row) =>
    row.traceId
      ? [
          {
            ...row,
            traceId: row.traceId,
            hint: hintFromSession({
              workflowRunId: row.workflowRunId,
              metadata: row.sessionMetadata,
            }),
          } satisfies TraceReviewRow,
        ]
      : [],
  );
}

async function loadTraceRows(
  traceIds: string[],
  scope: TraceQueryScope,
): Promise<TraceRows[]> {
  const [models, tools, reviews] = await Promise.all([
    loadModelRows(traceIds, scope),
    loadToolRows(traceIds, scope),
    loadReviewRows(traceIds, scope),
  ]);

  return mergeTraceRows([
    ...models.map((row) => ({
      traceId: row.traceId,
      models: [row],
      hint: row.hint,
    })),
    ...tools.map((row) => ({
      traceId: row.traceId,
      tools: [row],
      hint: row.hint,
    })),
    ...reviews.map((row) => ({
      traceId: row.traceId,
      reviews: [row],
      hint: row.hint,
    })),
  ]);
}

function matchesSearch(trace: TraceSummary, search: string | undefined) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return [
    trace.traceId,
    trace.sessionId,
    trace.sessionTitle,
    trace.agentId,
    trace.lastError,
  ].some((value) => value?.toLowerCase().includes(needle));
}

export async function listTraces(
  scope: TraceQueryScope,
  options: TraceListOptions = {},
): Promise<TraceSummary[]> {
  const traceIds = await listCandidateTraceIds(scope, options);
  const groups = await loadTraceRows(traceIds, scope);
  return groups
    .map((group) => buildTraceSummary(group))
    .filter((trace) => matchesSearch(trace, options.search))
    .sort((left, right) =>
      (right.startedAt ?? '').localeCompare(left.startedAt ?? ''),
    );
}

export async function getTrace(
  traceId: string,
  scope: TraceQueryScope,
): Promise<TraceDetail | null> {
  const groups = await loadTraceRows([traceId], scope);
  const group = groups.find((item) => item.traceId === traceId);
  return group ? buildTraceDetail(group) : null;
}
