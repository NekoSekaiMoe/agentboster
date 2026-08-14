import { closeRawSql, getRawQuery } from './db-raw-sql';

const DEFAULT_RETENTION_DAYS = 90;

async function main() {
  const parsed = Number(
    process.env.TRACE_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS,
  );
  const days = Number.isFinite(parsed)
    ? Math.max(1, Math.trunc(parsed))
    : DEFAULT_RETENTION_DAYS;
  const query = getRawQuery();
  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const events = await query(
    `DELETE FROM trace_events WHERE started_at < $1 RETURNING trace_id`,
    [cutoff],
  );
  const spans = await query(
    `DELETE FROM trace_spans WHERE started_at < $1 RETURNING trace_id`,
    [cutoff],
  );
  const runs = await query(
    `DELETE FROM trace_runs WHERE started_at < $1 RETURNING trace_id`,
    [cutoff],
  );
  console.log(
    `[cleanup-traces] retention_days=${days} cutoff=${cutoff} events=${events.length} spans=${spans.length} runs=${runs.length}`,
  );
  await closeRawSql();
}

main().catch(async (error) => {
  console.error('[cleanup-traces] failed:', error);
  await closeRawSql();
  process.exit(1);
});
