import { lt } from 'drizzle-orm';

import { db } from '@/lib/core/db';
import { traceEvents, traceRuns, traceSpans } from '@/lib/core/db/schema';

export const DEFAULT_TRACE_RETENTION_DAYS = 90;

/**
 * Delete canonical trace data older than the configured retention window.
 * Child rows are removed before runs because canonical tables deliberately
 * avoid hard foreign keys to keep callback ingestion resilient during deploys.
 */
export async function purgeExpiredTraces(
  retentionDays = DEFAULT_TRACE_RETENTION_DAYS,
): Promise<{ events: number; spans: number; runs: number }> {
  const days = Number.isFinite(retentionDays)
    ? Math.max(1, Math.trunc(retentionDays))
    : DEFAULT_TRACE_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const events = await db
    .delete(traceEvents)
    .where(lt(traceEvents.startedAt, cutoff));
  const spans = await db
    .delete(traceSpans)
    .where(lt(traceSpans.startedAt, cutoff));
  const runs = await db
    .delete(traceRuns)
    .where(lt(traceRuns.startedAt, cutoff));
  return {
    events: events.rowCount ?? 0,
    spans: spans.rowCount ?? 0,
    runs: runs.rowCount ?? 0,
  };
}
