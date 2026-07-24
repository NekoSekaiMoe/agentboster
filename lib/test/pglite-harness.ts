/**
 * In-memory Postgres test harness via PGlite.
 *
 * Borrowed from AionCore's zero-mock testing strategy: AionCore runs every
 * integration test against a real in-memory sqlite/sqlite::memory: so tests
 * exercise actual SQL rather than hand-rolled mocks. AgentBoster's existing
 * hand-rolled drizzle mock catches logic bugs but silently misses
 * SQL-dialect errors, schema/column mismatches, and constraint bugs. This
 * harness lets a test opt into a REAL in-memory Postgres for the specific
 * tables it cares about.
 *
 * Why per-test DDL and not "apply all migrations": the project's migrations
 * contain forward FK references and pgvector columns that PGlite can't
 * accept without extra setup. PGlite also doesn't ship pgvector. Each test
 * passes the DDL for exactly the tables it exercises (CREATE TABLE +
 * indexes), which is the minimum viable way to prove a schema shape works
 * against real Postgres SQL.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import * as schema from '@/lib/core/db/schema';

const MIGRATIONS_DIR = path.resolve(__dirname, '../core/db/migrations');

export interface PgLiteTestDb {
  /** Drizzle client bound to the in-memory Postgres + full schema types. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** The underlying PGlite instance — closed automatically afterAll. */
  client: PGlite;
}

async function applyDdl(client: PGlite, ddl: readonly string[]): Promise<void> {
  for (const stmt of ddl) {
    await client.exec(stmt);
  }
}

/**
 * @deprecated The project's migrations are not PGlite-friendly (forward FKs,
 * pgvector). Prefer setupPgLiteTestDb(ddl) with a per-test DDL list. Kept
 * for the day the migration set is cleaned up.
 */
export async function applyMigrations(client: PGlite): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    let cleaned = sql.replace(/-->\s*statement-breakpoint/g, ';');
    cleaned = cleaned.replace(/\bvector\s*\(\s*\d+\s*\)/gi, 'text');
    cleaned = cleaned.replace(/\bvector\b/gi, 'text');
    cleaned = cleaned.replace(/CREATE\s+EXTENSION\s+[^;]*vector[^;]*;/gi, '');
    if (cleaned.trim().length === 0) continue;
    await client.exec(cleaned);
  }
}

/**
 * Set up an isolated in-memory Postgres for a test file and apply a list of
 * raw DDL statements (CREATE TABLE / CREATE INDEX / etc). Each test file
 * passes the DDL for exactly the tables it exercises. Tears down
 * automatically after the file finishes.
 */
export function setupPgLiteTestDb(ddl: readonly string[] = []): PgLiteTestDb {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const ref: PgLiteTestDb = { db, client };

  beforeAll(async () => {
    await applyDdl(client, ddl);
  });

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // Ignore — PGlite may already be torn down at process exit.
    }
  });

  return ref;
}

/**
 * Truncate every table between tests for isolation. Pass the table names
 * you created in setupPgLiteTestDb's ddl. Uses TRUNCATE CASCADE so FK-linked
 * tables clear together.
 */
export async function resetDb(
  db: PgLiteTestDb['db'],
  tables: readonly string[],
): Promise<void> {
  if (tables.length === 0) return;
  await db.execute(
    `TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`,
  );
}
