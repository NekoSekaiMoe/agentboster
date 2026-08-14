import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
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
  getCanonicalTraceRun,
  listCanonicalTraceEvents,
  listCanonicalTraceRuns,
  listCanonicalTraceSpans,
} from './dal';

import {
  buildTraceDetail,
  buildTraceSummary,
  mergeTraceRows,
  type TraceDetail,
  type TraceEvent,
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
  const modelConditions: SQL[] = [sql`${traceIdExpression} IS NOT NULL`];
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
    .leftJoin(
      sessions,
      and(
        eq(agentToolActivityLogs.sessionId, sessions.id),
        or(
          eq(agentToolActivityLogs.userId, sessions.userId),
          and(isNull(agentToolActivityLogs.userId), isNull(sessions.userId)),
        ),
      ),
    )
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

function canonicalStatus(status: string): TraceStatusHint['workflowStatus'] {
  if (status === 'timeout') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

function canonicalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function canonicalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function canonicalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function canonicalEventKind(type: string): TraceEvent['kind'] {
  if (type === 'model' || type.startsWith('model.')) return 'model';
  if (type === 'review' || type.startsWith('security.')) return 'review';
  return 'tool';
}

async function loadCanonicalRows(
  traceIds: string[],
  scope: TraceQueryScope,
): Promise<TraceRows[]> {
  if (traceIds.length === 0) return [];
  const runs = await listCanonicalTraceRuns({
    traceIds,
    userId: scope.userId,
    limit: traceIds.length,
  });
  if (runs.length === 0) return [];

  const [spans, storedEvents] = await Promise.all([
    listCanonicalTraceSpans(runs.map((run) => run.traceId)),
    listCanonicalTraceEvents(runs.map((run) => run.traceId)),
  ]);
  const sessionIds = runs
    .map((run) => run.sessionId)
    .filter((id): id is string => Boolean(id));
  const sessionRows = sessionIds.length
    ? await db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(inArray(sessions.id, sessionIds))
    : [];
  const sessionTitles = new Map(sessionRows.map((row) => [row.id, row.title]));

  return runs.map((run) => {
    const runSpans = spans.filter((span) => span.traceId === run.traceId);
    const runEvents = storedEvents.filter(
      (event) => event.traceId === run.traceId,
    );
    const hint: TraceStatusHint = {
      workflowStatus: canonicalStatus(run.status),
      currentRunId:
        run.status === 'running' || run.status === 'pending'
          ? run.traceId
          : null,
      lastRunId: run.traceId,
      stoppedAt: run.completedAt,
      lastError: canonicalString(canonicalRecord(run.error).message),
    };
    const sessionTitle = run.sessionId
      ? (sessionTitles.get(run.sessionId) ?? null)
      : null;
    const models: TraceModelRow[] = [];
    const tools: TraceToolRow[] = [];
    const reviews: TraceReviewRow[] = [];
    for (const span of runSpans) {
      const metadata = canonicalRecord(span.metadata);
      if (span.type === 'model' || span.type.startsWith('model.')) {
        const output = canonicalRecord(span.output);
        models.push({
          id: span.id,
          traceId: run.traceId,
          sessionId: span.sessionId ?? run.sessionId,
          sessionTitle,
          userId: span.userId ?? run.userId,
          role: 'assistant',
          stepNumber: canonicalNumber(metadata.step),
          payload: {
            ...output,
            metadata: {
              ...metadata,
              traceDurationMs: span.durationMs,
              traceCompletedAt: span.completedAt?.toISOString(),
            },
          },
          createdAt: span.startedAt,
          sequence: Number(span.sequence),
          hint,
        });
      } else if (span.type === 'tool' || span.type.startsWith('tool.')) {
        tools.push({
          id: span.id,
          traceId: run.traceId,
          sessionId: span.sessionId ?? run.sessionId,
          sessionTitle,
          userId: span.userId ?? run.userId,
          agentId: span.agentId ?? 'unknown',
          toolName: canonicalString(metadata.toolName) ?? span.type,
          action: canonicalString(metadata.action) ?? 'other',
          target: canonicalString(metadata.target),
          arguments: span.input,
          result: span.output,
          outputText: canonicalString(metadata.outputText),
          success: span.status !== 'failed',
          error: canonicalString(canonicalRecord(span.error).message),
          durationMs: span.durationMs,
          startedAt: span.startedAt,
          completedAt: span.completedAt,
          sequence: Number(span.sequence),
          hint,
        });
      } else if (span.type === 'review' || span.type.startsWith('security.')) {
        reviews.push({
          id: span.id,
          traceId: run.traceId,
          taskId: span.taskId ?? '',
          sessionId: span.sessionId ?? run.sessionId,
          sessionTitle,
          userId: span.userId ?? run.userId,
          agentId: span.agentId,
          level: canonicalString(metadata.level) ?? 'unknown',
          decision: canonicalString(metadata.decision) ?? span.status,
          score: canonicalNumber(metadata.score),
          command: canonicalString(metadata.command) ?? '',
          reason: canonicalString(metadata.reason),
          createdAt: span.startedAt,
          sequence: Number(span.sequence),
          hint,
        });
      }
    }

    const events: TraceEvent[] = runEvents.map((event) => ({
      id: event.eventId,
      traceId: run.traceId,
      kind: canonicalEventKind(event.type),
      status:
        event.status === 'cancelled' || event.status === 'timeout'
          ? 'failed'
          : event.status === 'pending'
            ? 'pending'
            : event.status === 'running'
              ? 'running'
              : event.status === 'failed'
                ? 'failed'
                : 'completed',
      title: event.type,
      subtitle: canonicalString(canonicalRecord(event.metadata).message),
      step: canonicalNumber(canonicalRecord(event.metadata).step),
      startedAt: event.startedAt.toISOString(),
      completedAt: event.completedAt?.toISOString() ?? null,
      durationMs: event.durationMs,
      details: {
        input: event.input,
        output: event.output,
        error: event.error,
        metadata: event.metadata,
      },
      sequence: Number(event.sequence),
    }));

    return {
      traceId: run.traceId,
      run: {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
      },
      models,
      tools,
      reviews,
      events,
      hint,
    } satisfies TraceRows;
  });
}

async function listCanonicalSummaries(
  scope: TraceQueryScope,
  options: TraceListOptions,
): Promise<TraceSummary[]> {
  const runs = await listCanonicalTraceRuns({
    userId: scope.userId,
    limit: compactLimit(options.limit),
  });
  if (runs.length === 0) return [];
  const rows = await loadCanonicalRows(
    runs.map((run) => run.traceId),
    scope,
  );
  return rows
    .map((group) => buildTraceSummary(group))
    .filter((trace) => matchesSearch(trace, options.search))
    .sort((left, right) =>
      (right.startedAt ?? '').localeCompare(left.startedAt ?? ''),
    );
}

async function listLegacyTraces(
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

async function getLegacyTrace(
  traceId: string,
  scope: TraceQueryScope,
): Promise<TraceDetail | null> {
  const groups = await loadTraceRows([traceId], scope);
  const group = groups.find((item) => item.traceId === traceId);
  return group ? buildTraceDetail(group) : null;
}

/**
 * Canonical-first Trace read API. Legacy aggregation is deliberately kept as
 * a bounded compatibility fallback for records not yet backfilled.
 */
export async function listTraces(
  scope: TraceQueryScope,
  options: TraceListOptions = {},
): Promise<TraceSummary[]> {
  const canonical = await listCanonicalSummaries(scope, options);
  const canonicalIds = new Set(canonical.map((trace) => trace.traceId));
  const legacy = await listLegacyTraces(scope, options);
  return [
    ...canonical,
    ...legacy.filter((trace) => !canonicalIds.has(trace.traceId)),
  ]
    .sort((left, right) =>
      (right.startedAt ?? '').localeCompare(left.startedAt ?? ''),
    )
    .slice(0, compactLimit(options.limit));
}

export async function getTrace(
  traceId: string,
  scope: TraceQueryScope,
): Promise<TraceDetail | null> {
  const canonicalRun = await getCanonicalTraceRun(traceId);
  if (canonicalRun && (!scope.userId || canonicalRun.userId === scope.userId)) {
    const rows = await loadCanonicalRows([traceId], scope);
    const group = rows.find((row) => row.traceId === traceId);
    return group ? buildTraceDetail(group) : null;
  }
  return getLegacyTrace(traceId, scope);
}
