/**
 * Trace retention cleanup — thin CLI wrapper around the shared
 * implementation in lib/core/trace/retention.ts (purgeExpiredTraces).
 *
 * The shared function is the single source of truth for the retention
 * semantics (child rows before runs, same cutoff, same day clamping, batched
 * until the expired backlog is drained), so this script only parses
 * TRACE_RETENTION_DAYS and reports the result.
 *
 * Lifecycle: purgeExpiredTraces runs on the shared `db` driver
 * (lib/core/db), which on self-hosted deployments needs the node-postgres
 * warm-up before first use and a pool close on exit. Both are handled here
 * via a dynamic import of the host-only pg driver (this script runs under
 * tsx on the host and is never part of the workflow bundle, but the
 * dynamic import keeps that isolation explicit). The raw-SQL import is kept
 * solely for pool teardown parity with the other host scripts.
 */
import { closeRawSql } from './db-raw-sql';
import {
  DEFAULT_TRACE_RETENTION_DAYS,
  purgeExpiredTraces,
} from '@/lib/core/trace/retention';

async function main() {
  const parsed = Number(
    process.env.TRACE_RETENTION_DAYS ?? DEFAULT_TRACE_RETENTION_DAYS,
  );
  const days = Number.isFinite(parsed)
    ? Math.max(1, Math.trunc(parsed))
    : DEFAULT_TRACE_RETENTION_DAYS;
  const { warmupDatabase } = await import('@/lib/core/db/pg-driver');
  await warmupDatabase();
  try {
    const result = await purgeExpiredTraces(days);
    console.log(
      `[cleanup-traces] retention_days=${days} events=${result.events} spans=${result.spans} runs=${result.runs}`,
    );
  } finally {
    // Close the shared driver pool on both success and failure paths so a
    // self-hosted run does not hang on an open connection.
    const { closeDatabase } = await import('@/lib/core/db/pg-driver');
    await closeDatabase();
  }
}

main()
  .then(() => closeRawSql())
  .catch(async (error) => {
    console.error('[cleanup-traces] failed:', error);
    await closeRawSql();
    process.exit(1);
  });
