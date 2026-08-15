import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/core/db';
import { sessions } from '@/lib/core/db/schema';
import {
  CANONICAL_QUERY_LIMIT_MAX,
  getCanonicalTraceRun,
  listCanonicalTraceEvents,
  listCanonicalTraceRuns,
  listCanonicalTraceSpans,
} from './dal';
import {
  buildTraceDetail,
  buildTraceSummary,
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

function compactLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit ?? 100), 1), 250);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function canonicalStatus(status: string): TraceStatusHint['workflowStatus'] {
  if (status === 'timeout') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

function canonicalEventKind(type: string): TraceEvent['kind'] {
  if (type === 'model' || type.startsWith('model.')) return 'model';
  if (
    type === 'review' ||
    type.startsWith('review.') ||
    type.startsWith('security.')
  ) {
    return 'review';
  }
  return 'tool';
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
        .where(
          and(
            inArray(sessions.id, sessionIds),
            scope.userId ? eq(sessions.userId, scope.userId) : undefined,
          ),
        )
    : [];
  const sessionTitles = new Map(sessionRows.map((row) => [row.id, row.title]));

  const spansByTrace = new Map<string, typeof spans>();
  for (const span of spans) {
    const group = spansByTrace.get(span.traceId) ?? [];
    group.push(span);
    spansByTrace.set(span.traceId, group);
  }
  const eventsByTrace = new Map<string, typeof storedEvents>();
  for (const event of storedEvents) {
    const group = eventsByTrace.get(event.traceId) ?? [];
    group.push(event);
    eventsByTrace.set(event.traceId, group);
  }

  return runs.map((run) => {
    const runSpans = spansByTrace.get(run.traceId) ?? [];
    const runEvents = eventsByTrace.get(run.traceId) ?? [];
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
      } else if (
        span.type === 'review' ||
        span.type.startsWith('review.') ||
        span.type.startsWith('security.')
      ) {
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

export async function listTraces(
  scope: TraceQueryScope,
  options: TraceListOptions = {},
): Promise<TraceSummary[]> {
  // The DAL cannot push arbitrary search terms down (only trace_id ILIKE),
  // so widen the candidate pool and keep the in-memory filter + sort + slice.
  const candidateLimit = Math.min(
    Math.max(compactLimit(options.limit) * 4, 500),
    CANONICAL_QUERY_LIMIT_MAX,
  );
  const runs = await listCanonicalTraceRuns({
    userId: scope.userId,
    search: options.search,
    limit: candidateLimit,
  });
  const rows = await loadCanonicalRows(
    runs.map((run) => run.traceId),
    scope,
  );
  return rows
    .map((group) => buildTraceSummary(group))
    .filter((trace) => matchesSearch(trace, options.search))
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
  if (!canonicalRun || (scope.userId && canonicalRun.userId !== scope.userId)) {
    return null;
  }
  const rows = await loadCanonicalRows([traceId], scope);
  const group = rows.find((row) => row.traceId === traceId);
  return group ? buildTraceDetail(group) : null;
}
