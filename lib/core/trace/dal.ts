import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '@/lib/core/db';
import { traceEvents, traceRuns, traceSpans } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('core.trace.dal');

/** Upper bound shared by every canonical trace listing helper. */
export const CANONICAL_QUERY_LIMIT_MAX = 10000;

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'stopped',
]);

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

type TraceDb = typeof db;
type TraceTx = Parameters<Parameters<TraceDb['transaction']>[0]>[0];

function isMissingTraceTableError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /does not exist/i.test(message) &&
    /trace_(runs|spans|events)/i.test(message)
  );
}

/**
 * Run a canonical-trace query, degrading to `fallback` when the canonical
 * tables have not been created yet (PostgreSQL 42P01 / missing relation).
 * Any other error propagates so genuine failures stay visible.
 */
export async function canonicalOr<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTraceTableError(error)) {
      logger.warn('canonical trace storage unavailable, using fallback', {
        message: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
    throw error;
  }
}

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

/** Internal sentinel: abort the ingest transaction on a replayed record. */
class ReplayedTraceRecord<T> extends Error {
  constructor(public readonly record: T) {
    super('ReplayedTraceRecord');
    this.name = 'ReplayedTraceRecord';
  }
}

async function ensureTraceRunInternal(
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
  if (existing) {
    const [row] = await db
      .update(traceRuns)
      .set({
        status: TERMINAL_RUN_STATUSES.has(existing.status)
          ? existing.status
          : values.status,
        completedAt: values.completedAt ?? existing.completedAt,
        durationMs: values.durationMs ?? existing.durationMs,
        output: values.output ?? existing.output,
        error: values.error ?? existing.error,
        metadata: values.metadata ?? existing.metadata,
        updatedAt: new Date(),
      })
      .where(eq(traceRuns.traceId, input.traceId))
      .returning();
    return { record: row ?? existing, duplicate: true };
  }

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
  if (!row) throw new Error(`Trace run ${input.traceId} was not persisted`);
  return { record: row, duplicate: false };
}

/** Insert or merge a top-level run. Replays update progress, never duplicate it. */
export async function ensureTraceRun(
  input: TraceRunInput,
): Promise<TraceIngestResult<typeof traceRuns.$inferSelect> | null> {
  return canonicalOr(() => ensureTraceRunInternal(input), null);
}

async function allocateSequence(
  traceId: string,
  executor: TraceDb | TraceTx,
): Promise<number> {
  const [row] = await executor
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

function spanValues(input: TraceSpanInput, sequence: number) {
  return {
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
  };
}

function eventValues(input: TraceEventInput, sequence: number) {
  return {
    eventId: input.eventId?.trim() || `event:${input.idempotencyKey}`,
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
  };
}

/**
 * Allocate the sequence and insert the child row in ONE transaction. When the
 * insert loses an idempotency race, the sequence increment is rolled back with
 * the transaction instead of burning a gap.
 *
 * Drizzle's builder types do not survive `T extends typeof traceSpans |
 * typeof traceEvents` generics across insert/select inference, so the table
 * choice is closed over in `write`/`replayed` callbacks (concrete table per
 * call site) and the result row is cast once at the caller.
 */
async function ingestChildRecord(
  traceId: string,
  write: (tx: TraceTx, sequence: number) => Promise<unknown>,
  replayed: (tx: TraceTx) => Promise<unknown>,
): Promise<{ record: unknown; duplicate: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      const sequence = await allocateSequence(traceId, tx);
      const row = await write(tx, sequence);
      if (row) return { record: row, duplicate: false };
      const duplicate = await replayed(tx);
      if (!duplicate)
        throw new Error(`Trace record replay for ${traceId} was not persisted`);
      // Abort so the wasted sequence allocation rolls back with the tx.
      throw new ReplayedTraceRecord(duplicate);
    });
  } catch (error) {
    if (error instanceof ReplayedTraceRecord) {
      return { record: error.record, duplicate: true };
    }
    throw error;
  }
}

/** Persist a span using an atomic insert-on-conflict idempotency path. */
export async function ingestTraceSpan(
  input: TraceSpanInput,
): Promise<TraceIngestResult<typeof traceSpans.$inferSelect> | null> {
  await ensureRunForRecord(input);
  return canonicalOr(async () => {
    const result = await ingestChildRecord(
      input.traceId,
      async (tx, sequence) => {
        const [row] = await tx
          .insert(traceSpans)
          .values({ ...spanValues(input, sequence) })
          .onConflictDoNothing({
            target: [traceSpans.traceId, traceSpans.idempotencyKey],
          })
          .returning();
        return row ?? null;
      },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(traceSpans)
          .where(
            and(
              eq(traceSpans.traceId, input.traceId),
              eq(traceSpans.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    );
    return result as TraceIngestResult<typeof traceSpans.$inferSelect>;
  }, null);
}

/** Persist an append-only event. Event IDs and idempotency keys are producer stable. */
export async function ingestTraceEvent(
  input: TraceEventInput,
): Promise<TraceIngestResult<typeof traceEvents.$inferSelect> | null> {
  await ensureRunForRecord(input);
  return canonicalOr(async () => {
    const result = await ingestChildRecord(
      input.traceId,
      async (tx, sequence) => {
        const [row] = await tx
          .insert(traceEvents)
          .values({ ...eventValues(input, sequence) })
          .onConflictDoNothing({
            target: [traceEvents.traceId, traceEvents.idempotencyKey],
          })
          .returning();
        return row ?? null;
      },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(traceEvents)
          .where(
            and(
              eq(traceEvents.traceId, input.traceId),
              eq(traceEvents.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    );
    return result as TraceIngestResult<typeof traceEvents.$inferSelect>;
  }, null);
}

export async function finalizeTraceRun(input: {
  traceId: string;
  status: TraceStatus | string;
  completedAt?: Date;
  durationMs?: number | null;
  error?: unknown;
  output?: unknown;
}): Promise<typeof traceRuns.$inferSelect | null> {
  return canonicalOr(async () => {
    const [existing] = await db
      .select()
      .from(traceRuns)
      .where(eq(traceRuns.traceId, input.traceId))
      .limit(1);
    if (!existing) return null;
    if (TERMINAL_RUN_STATUSES.has(existing.status)) return null;
    const set: Record<string, unknown> = {
      status: input.status,
      completedAt: input.completedAt ?? new Date(),
      error: asJson(input.error),
      output: asJson(input.output),
      updatedAt: new Date(),
    };
    if (input.durationMs !== undefined) set.durationMs = input.durationMs;
    const [row] = await db
      .update(traceRuns)
      .set(set)
      .where(eq(traceRuns.traceId, input.traceId))
      .returning();
    return row ?? null;
  }, null);
}

export async function getCanonicalTraceRun(traceId: string) {
  // Same 42P01 fallback as the other canonical readers: a deployment whose
  // trace tables have not been created yet must degrade to "no run" rather
  // than propagate a missing-table error to callers.
  return canonicalOr(async () => {
    const [row] = await db
      .select()
      .from(traceRuns)
      .where(eq(traceRuns.traceId, traceId))
      .limit(1);
    return row ?? null;
  }, null);
}

export async function listCanonicalTraceRuns(input: {
  userId?: string;
  traceIds?: string[];
  limit?: number;
  search?: string;
  startedAfter?: Date;
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
  if (input.startedAfter && !Number.isNaN(input.startedAfter.getTime())) {
    conditions.push(gt(traceRuns.startedAt, input.startedAfter));
  }
  return db
    .select()
    .from(traceRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(traceRuns.startedAt), desc(traceRuns.traceId))
    .limit(
      Math.min(Math.max(input.limit ?? 250, 1), CANONICAL_QUERY_LIMIT_MAX),
    );
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
    .limit(
      Math.min(Math.max(input.limit ?? 1000, 1), CANONICAL_QUERY_LIMIT_MAX),
    );
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
    .limit(
      Math.min(Math.max(input.limit ?? 1000, 1), CANONICAL_QUERY_LIMIT_MAX),
    );
}

export async function getCanonicalTraceStats(
  input: {
    userId?: string;
    /** Rolling window in days. Defaults to 7. */
    days?: number;
  } = {},
) {
  const days =
    Number.isFinite(input.days) && (input.days ?? 0) > 0
      ? Math.trunc(input.days as number)
      : 7;
  const startedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const runs = await listCanonicalTraceRuns({
    userId: input.userId,
    limit: CANONICAL_QUERY_LIMIT_MAX,
    startedAfter,
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
