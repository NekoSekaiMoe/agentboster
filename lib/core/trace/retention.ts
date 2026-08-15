import { inArray, lt } from 'drizzle-orm';

import { db } from '@/lib/core/db';
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
 * Delete canonical trace data older than the retention window, in one
 * transaction: select the expired runs first, then delete their child rows
 * (trace_events, trace_spans) by trace_id, then the runs themselves. Child
 * rows are removed before runs because canonical tables deliberately avoid
 * hard foreign keys to keep callback ingestion resilient during deploys.
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
    .where(lt(traceRuns.startedAt, cutoff));
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
    events: events.rowCount ?? 0,
    spans: spans.rowCount ?? 0,
    runs: runs.rowCount ?? 0,
  };
}

/** Back-compatible wrapper: runs the cleanup in a single transaction. */
export async function purgeExpiredTraces(
  retentionDays: number = DEFAULT_TRACE_RETENTION_DAYS,
): Promise<TraceCleanupResult> {
  try {
    return await db.transaction((tx) =>
      cleanupExpiredTraces(tx, retentionDays),
    );
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
