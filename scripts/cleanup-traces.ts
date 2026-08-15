/**
 * Trace retention cleanup — thin CLI wrapper around the shared
 * implementation in lib/core/trace/retention.ts (purgeExpiredTraces).
 *
 * The shared function is the single source of truth for the retention
 * semantics (child rows before runs, same cutoff, same day clamping), so
 * this script only parses TRACE_RETENTION_DAYS and reports the result.
 * It keeps the raw-SQL import solely for pool teardown parity with the
 * other host scripts.
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
  const result = await purgeExpiredTraces(days);
  console.log(
    `[cleanup-traces] retention_days=${days} events=${result.events} spans=${result.spans} runs=${result.runs}`,
  );
  await closeRawSql();
}

main().catch(async (error) => {
  console.error('[cleanup-traces] failed:', error);
  await closeRawSql();
  process.exit(1);
});
