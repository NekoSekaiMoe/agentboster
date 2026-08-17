import { inArray, lt } from 'drizzle-orm';

import { db } from '@/lib/core/db';
import { atomicWriteMode } from '@/lib/core/db/atomic';
import { traceEvents, traceRuns, traceSpans } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

export const DEFAULT_TRACE_RETENTION_DAYS = 90;

const logger = createLogger('core.trace.retention');

type TraceDb = typeof db;
type TraceTx = Parameters<Parameters<TraceDb['transaction']>[0]>[0];

export interface TraceCleanupResult {
  events: number;
  spans: number;
  runs: number;
}

/**
 * Delete-result row count across drivers: node-postgres reports
 * `rowCount`, PGlite reports `affectedRows` (its result type lacks
 * `rowCount` entirely, which used to make every cleanup count read 0).
 */
function deletedCount(result: {
  rowCount?: number;
  affectedRows?: number;
}): number | undefined {
  return result.rowCount ?? result.affectedRows ?? undefined;
}

/** Max expired runs deleted per transaction. Batching bounds the FOR UPDATE
 * row-lock footprint and the delete volume so a long retention backlog
 * doesn't hold locks (and tie up a connection) for the whole table; callers
 * loop until a batch reports zero runs deleted. */
export const TRACE_CLEANUP_BATCH_SIZE = 500;

/**
 * Delete canonical trace data older than the retention window, in one
 * transaction: select the expired runs first (locking the run rows with
 * FOR UPDATE so a concurrent ingest allocating a sequence on the same run
 * serializes behind this transaction), then delete their child rows
 * (trace_events, trace_spans) by trace_id, then the runs themselves. Child
 * rows are removed before runs because canonical tables deliberately avoid
 * hard foreign keys to keep callback ingestion resilient during deploys.
 *
 * Without the row lock there is a race window: an ingest that commits a new
 * span between the SELECT and the DELETE would either orphan that span or
 * have it deleted as a side effect of the by-trace_id delete even though it
 * was brand new. FOR UPDATE closes the window on the run row, which is the
 * row every ingest transaction updates via allocateSequence().
 *
 * Only TRACE_CLEANUP_BATCH_SIZE runs are processed per call — loop until
 * `runs === 0` to drain a large backlog (each iteration is its own
 * transaction, so progress survives interruption).
 *
 * The db (or transaction) handle is injectable so callers such as the
 * cleanup script can reuse this against their own connection.
 */
export async function cleanupExpiredTraces(
  dbOrTx: TraceDb | TraceTx,
  retentionDays: number = DEFAULT_TRACE_RETENTION_DAYS,
): Promise<TraceCleanupResult> {
  const days = Number.isFinite(retentionDays)
    ? Math.max(1, Math.trunc(retentionDays))
    : DEFAULT_TRACE_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const expiredRuns = await dbOrTx
    .select({ traceId: traceRuns.traceId })
    .from(traceRuns)
    .where(lt(traceRuns.startedAt, cutoff))
    .orderBy(traceRuns.startedAt)
    .limit(TRACE_CLEANUP_BATCH_SIZE)
    .for('update');
  const traceIds = expiredRuns.map((run) => run.traceId);
  if (traceIds.length === 0) return { events: 0, spans: 0, runs: 0 };

  const events = await dbOrTx
    .delete(traceEvents)
    .where(inArray(traceEvents.traceId, traceIds));
  const spans = await dbOrTx
    .delete(traceSpans)
    .where(inArray(traceSpans.traceId, traceIds));
  const runs = await dbOrTx
    .delete(traceRuns)
    .where(inArray(traceRuns.traceId, traceIds));
  return {
    events: deletedCount(events) ?? 0,
    spans: deletedCount(spans) ?? 0,
    runs: deletedCount(runs) ?? 0,
  };
}

/** Back-compatible wrapper: runs the cleanup in batches of
 * TRACE_CLEANUP_BATCH_SIZE until no expired runs remain, one transaction
 * per batch. */
export async function purgeExpiredTraces(
  retentionDays: number = DEFAULT_TRACE_RETENTION_DAYS,
): Promise<TraceCleanupResult> {
  try {
    const totals: TraceCleanupResult = { events: 0, spans: 0, runs: 0 };
    // Loop until a batch deletes no runs: cleanupExpiredTraces is capped at
    // TRACE_CLEANUP_BATCH_SIZE runs per transaction, so a large retention
    // backlog drains in bounded chunks instead of one giant lock window.
    for (;;) {
      // node-postgres runs each batch in an interactive transaction so the
      // FOR UPDATE run-row lock serializes against concurrent ingests.
      // neon-http has no interactive transactions (db.transaction throws
      // "No transactions support in neon-http driver"); the deletes are
      // idempotent, so the batch runs directly on db — the residual race
      // (a span ingested mid-sweep may outlive its run until the next
      // sweep) is acceptable for best-effort retention cleanup.
      const batch =
        atomicWriteMode() === 'neon'
          ? await cleanupExpiredTraces(db, retentionDays)
          : await db.transaction((tx) =>
              cleanupExpiredTraces(tx, retentionDays),
            );
      totals.events += batch.events;
      totals.spans += batch.spans;
      totals.runs += batch.runs;
      if (batch.runs === 0) break;
    }
    return totals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /relation .*trace_(runs|spans|events).* does not exist/i.test(message)
    ) {
      logger.warn('canonical trace storage unavailable, skipping cleanup', {
        message,
      });
      return { events: 0, spans: 0, runs: 0 };
    }
    throw error;
  }
}
