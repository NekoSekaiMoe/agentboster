import { closeRawSql, getRawSql } from './db-raw-sql';

async function main() {
  console.log('[db:ensure-vector] ensuring pgvector extension');

  const sql = getRawSql();
  await sql`CREATE EXTENSION IF NOT EXISTS vector;`;

  console.log('[db:ensure-vector] pgvector extension is ready');
  await closeRawSql();
}

main().catch(async (error) => {
  console.error('[db:ensure-vector] failed:', error);
  await closeRawSql();
  process.exit(1);
});
