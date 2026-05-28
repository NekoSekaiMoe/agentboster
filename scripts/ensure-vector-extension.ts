import { neon } from '@neondatabase/serverless';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to enable the vector extension.');
  }

  console.log('[db:ensure-vector] ensuring pgvector extension');

  const sql = neon(databaseUrl);
  await sql`CREATE EXTENSION IF NOT EXISTS vector;`;

  console.log('[db:ensure-vector] pgvector extension is ready');
}

main().catch((error) => {
  console.error('[db:ensure-vector] failed:', error);
  process.exit(1);
});
