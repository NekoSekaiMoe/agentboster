import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '@/lib/core/db';
import { traceEvents, traceRuns, traceSpans } from '@/lib/core/db/schema';

export type TraceStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'stopped';

export type TraceEnvelopeBase = {
  traceId: string;
  spanId?: string | null;
  parentSpanId?: string | null;
  source: string;
  type: string;
  status?: TraceStatus | string;
  startedAt?: Date;
  completedAt?: Date | null;
  durationMs?: number | null;
  userId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
  /** Producer-stable key reused when a callback or Workflow step is retried. */
  idempotencyKey: string;
};

export type TraceRunInput = Omit<TraceEnvelopeBase, 'type'> & {
  type?: string;
  spanId?: string | null;
};

export type TraceSpanInput = TraceEnvelopeBase;
export type TraceEventInput = TraceEnvelopeBase & { eventId?: string };

export type TraceIngestResult<T> = {
  record: T;
  duplicate: boolean;
};

function asDate(value: Date | null | undefined): Date {
  return value && !Number.isNaN(value.getTime()) ? value : new Date();
}

function nullable(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

function asJson(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rootSpanId(input: TraceRunInput): string {
  return input.spanId?.trim() || `run:${input.traceId}`;
}

/** Insert or merge a top-level run. Replays update progress, never duplicate it. */
export async function ensureTraceRun(
  input: TraceRunInput,
): Promise<TraceIngestResult<typeof traceRuns.$inferSelect>> {
  const values = {
    traceId: input.traceId,
    spanId: rootSpanId(input),
    parentSpanId: nullable(input.parentSpanId),
    source: input.source,
    status: input.status ?? 'pending',
    startedAt: asDate(input.startedAt),
    completedAt: input.completedAt ?? null,
    durationMs: input.durationMs ?? null,
    userId: nullable(input.userId),
    sessionId: nullable(input.sessionId),
    taskId: nullable(input.taskId),
    workspaceId: nullable(input.workspaceId),
    nodeId: nullable(input.nodeId),
    agentId: nullable(input.agentId),
    input: asJson(input.input),
    output: asJson(input.output),
    error: asJson(input.error),
    metadata: input.metadata ?? undefined,
    idempotencyKey: input.idempotencyKey,
  };

  const [row] = await db
    .insert(traceRuns)
    .values(values)
    .onConflictDoUpdate({
      target: traceRuns.traceId,
      set: {
        status: sql`CASE
          WHEN ${traceRuns.status} IN ('completed', 'failed', 'cancelled', 'timeout', 'stopped')
            THEN ${traceRuns.status}
          ELSE EXCLUDED.status
        END`,
        completedAt: sql`COALESCE(EXCLUDED.completed_at, ${traceRuns.completedAt})`,
        durationMs: sql`COALESCE(EXCLUDED.duration_ms, ${traceRuns.durationMs})`,
        output: sql`COALESCE(EXCLUDED.output, ${traceRuns.output})`,
        error: sql`COALESCE(EXCLUDED.error, ${traceRuns.error})`,
        metadata: sql`COALESCE(EXCLUDED.metadata, ${traceRuns.metadata})`,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (row) return { record: row, duplicate: false };
  const [existing] = await db
    .select()
    .from(traceRuns)
    .where(
      and(
        eq(traceRuns.traceId, input.traceId),
        eq(traceRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error(`Trace run ${input.traceId} was not persisted`);
  return { record: existing, duplicate: true };
}

async function allocateSequence(traceId: string): Promise<number> {
  const [row] = await db
    .update(traceRuns)
    .set({
      nextSequence: sql`${traceRuns.nextSequence} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(traceRuns.traceId, traceId))
    .returning({ sequence: traceRuns.nextSequence });
  if (!row) throw new Error(`Trace run ${traceId} does not exist`);
  return Number(row.sequence);
}

async function ensureRunForRecord(input: TraceEnvelopeBase) {
  await ensureTraceRun({
    traceId: input.traceId,
    spanId: `run:${input.traceId}`,
    source: input.source,
    type: 'run',
    status: 'running',
    startedAt: input.startedAt,
    userId: input.userId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    agentId: input.agentId,
    idempotencyKey: `run:${input.traceId}`,
  });
}

/** Persist a span using an atomic insert-on-conflict idempotency path. */
export async function ingestTraceSpan(
  input: TraceSpanInput,
): Promise<TraceIngestResult<typeof traceSpans.$inferSelect>> {
  await ensureRunForRecord(input);
  const existing = await db
    .select()
    .from(traceSpans)
    .where(
      and(
        eq(traceSpans.traceId, input.traceId),
        eq(traceSpans.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) return { record: existing[0], duplicate: true };

  const sequence = await allocateSequence(input.traceId);
  const [row] = await db
    .insert(traceSpans)
    .values({
      traceId: input.traceId,
      spanId: input.spanId?.trim() || `span:${input.idempotencyKey}`,
      parentSpanId: nullable(input.parentSpanId),
      sequence,
      source: input.source,
      type: input.type,
      status: input.status ?? 'pending',
      startedAt: asDate(input.startedAt),
      completedAt: input.completedAt ?? null,
      durationMs: input.durationMs ?? null,
      userId: nullable(input.userId),
      sessionId: nullable(input.sessionId),
      taskId: nullable(input.taskId),
      workspaceId: nullable(input.workspaceId),
      nodeId: nullable(input.nodeId),
      agentId: nullable(input.agentId),
      input: input.input,
      output: input.output,
      error: input.error,
      metadata: input.metadata ?? undefined,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [traceSpans.traceId, traceSpans.idempotencyKey],
    })
    .returning();
  if (row) return { record: row, duplicate: false };
  const [duplicate] = await db
    .select()
    .from(traceSpans)
    .where(
      and(
        eq(traceSpans.traceId, input.traceId),
        eq(traceSpans.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!duplicate)
    throw new Error(`Trace span ${input.idempotencyKey} was not persisted`);
  return { record: duplicate, duplicate: true };
}

/** Persist an append-only event. Event IDs and idempotency keys are producer stable. */
export async function ingestTraceEvent(
  input: TraceEventInput,
): Promise<TraceIngestResult<typeof traceEvents.$inferSelect>> {
  await ensureRunForRecord(input);
  const existing = await db
    .select()
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.traceId, input.traceId),
        eq(traceEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) return { record: existing[0], duplicate: true };

  const sequence = await allocateSequence(input.traceId);
  const eventId = input.eventId?.trim() || `event:${input.idempotencyKey}`;
  const [row] = await db
    .insert(traceEvents)
    .values({
      eventId,
      traceId: input.traceId,
      spanId: nullable(input.spanId),
      parentSpanId: nullable(input.parentSpanId),
      sequence,
      source: input.source,
      type: input.type,
      status: input.status ?? 'pending',
      startedAt: asDate(input.startedAt),
      completedAt: input.completedAt ?? null,
      durationMs: input.durationMs ?? null,
      userId: nullable(input.userId),
      sessionId: nullable(input.sessionId),
      taskId: nullable(input.taskId),
      workspaceId: nullable(input.workspaceId),
      nodeId: nullable(input.nodeId),
      agentId: nullable(input.agentId),
      input: input.input,
      output: input.output,
      error: input.error,
      metadata: input.metadata ?? undefined,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [traceEvents.traceId, traceEvents.idempotencyKey],
    })
    .returning();
  if (row) return { record: row, duplicate: false };
  const [duplicate] = await db
    .select()
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.traceId, input.traceId),
        eq(traceEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!duplicate)
    throw new Error(`Trace event ${input.idempotencyKey} was not persisted`);
  return { record: duplicate, duplicate: true };
}

export async function finalizeTraceRun(input: {
  traceId: string;
  status: TraceStatus | string;
  completedAt?: Date;
  durationMs?: number | null;
  error?: unknown;
  output?: unknown;
}) {
  const [row] = await db
    .update(traceRuns)
    .set({
      status: input.status,
      completedAt: input.completedAt ?? new Date(),
      durationMs: input.durationMs ?? null,
      error: asJson(input.error),
      output: asJson(input.output),
      updatedAt: new Date(),
    })
    .where(eq(traceRuns.traceId, input.traceId))
    .returning();
  return row ?? null;
}

export async function getCanonicalTraceRun(traceId: string) {
  const [row] = await db
    .select()
    .from(traceRuns)
    .where(eq(traceRuns.traceId, traceId))
    .limit(1);
  return row ?? null;
}

export async function listCanonicalTraceRuns(input: {
  userId?: string;
  traceIds?: string[];
  limit?: number;
  search?: string;
}) {
  const conditions: SQL[] = [];
  if (input.userId) conditions.push(eq(traceRuns.userId, input.userId));
  if (input.traceIds?.length) {
    conditions.push(inArray(traceRuns.traceId, input.traceIds));
  }
  if (input.search?.trim()) {
    const pattern = `%${input.search.trim()}%`;
    conditions.push(sql`${traceRuns.traceId} ILIKE ${pattern}`);
  }
  return db
    .select()
    .from(traceRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(traceRuns.startedAt), desc(traceRuns.traceId))
    .limit(Math.min(Math.max(input.limit ?? 250, 1), 250));
}

export async function listCanonicalTraceSpans(traceIds: string[]) {
  if (traceIds.length === 0) return [];
  return db
    .select()
    .from(traceSpans)
    .where(inArray(traceSpans.traceId, traceIds))
    .orderBy(
      asc(traceSpans.traceId),
      asc(traceSpans.sequence),
      asc(traceSpans.spanId),
    );
}

export async function listCanonicalTraceEvents(traceIds: string[]) {
  if (traceIds.length === 0) return [];
  return db
    .select()
    .from(traceEvents)
    .where(inArray(traceEvents.traceId, traceIds))
    .orderBy(
      asc(traceEvents.traceId),
      asc(traceEvents.sequence),
      asc(traceEvents.eventId),
    );
}

export async function listCanonicalReviewSpans(input: {
  userId?: string;
  limit?: number;
}) {
  const conditions = [eq(traceSpans.type, 'review')];
  if (input.userId) conditions.push(eq(traceSpans.userId, input.userId));
  return db
    .select()
    .from(traceSpans)
    .where(and(...conditions))
    .orderBy(
      desc(traceSpans.startedAt),
      desc(traceSpans.sequence),
      desc(traceSpans.spanId),
    )
    .limit(Math.min(Math.max(input.limit ?? 1000, 1), 10000));
}

export async function listCanonicalToolSpans(input: {
  userId?: string;
  limit?: number;
}) {
  const conditions = [eq(traceSpans.type, 'tool')];
  if (input.userId) conditions.push(eq(traceSpans.userId, input.userId));
  return db
    .select()
    .from(traceSpans)
    .where(and(...conditions))
    .orderBy(
      desc(traceSpans.startedAt),
      desc(traceSpans.sequence),
      desc(traceSpans.spanId),
    )
    .limit(Math.min(Math.max(input.limit ?? 1000, 1), 10000));
}

export async function getCanonicalTraceStats(input: { userId?: string } = {}) {
  const runs = await listCanonicalTraceRuns({
    userId: input.userId,
    limit: 10000,
  });
  const spans = await listCanonicalTraceSpans(runs.map((run) => run.traceId));
  const events = await listCanonicalTraceEvents(runs.map((run) => run.traceId));
  const byStatus = new Map<string, number>();
  for (const run of runs) {
    byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
  }
  let totalTokens = 0;
  for (const span of spans) {
    if (
      span.type !== 'model' ||
      !span.output ||
      typeof span.output !== 'object'
    ) {
      continue;
    }
    const usage = (span.output as { usage?: { totalTokens?: unknown } }).usage;
    if (typeof usage?.totalTokens === 'number')
      totalTokens += usage.totalTokens;
  }
  return {
    runCount: runs.length,
    spanCount: spans.length,
    eventCount: events.length,
    modelSpanCount: spans.filter((span) => span.type === 'model').length,
    toolSpanCount: spans.filter((span) => span.type === 'tool').length,
    reviewSpanCount: spans.filter((span) => span.type === 'review').length,
    failureCount: spans.filter((span) => span.status === 'failed').length,
    totalTokens,
    statuses: Object.fromEntries(byStatus),
  };
}
