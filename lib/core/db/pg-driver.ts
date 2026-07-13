/**
 * node-postgres driver builder — HOST-ONLY.
 *
 * This file is imported EXCLUSIVELY from `instrumentation.ts` (`register()`),
 * which runs in the Node.js server process and is never reachable from a
 * workflow body. That isolation is the whole point: `pg` and
 * `drizzle-orm/node-postgres` pull in `node:net` / `node:tls`, and the workflow
 * bundler hard-fails `yarn build` if it can statically reach a `'pg'` import —
 * even through `await import('pg')` (the dynamic-import trick only hides Node
 * BUILT-IN specifiers, not third-party packages that require them).
 *
 * So the rule is: `db/index.ts` (workflow-reachable) must never name `pg`. All
 * pg references live here, and the built instance is handed back to
 * `db/index.ts` via `setDb()`.
 *
 * Do NOT import this file from anything other than `instrumentation.ts`.
 */
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { resolveDriver, requireDatabaseUrl, setDb } from './index';
import * as schema from './schema';

let _warmed = false;

/**
 * Build the node-postgres driver and inject it into `db/index.ts`.
 *
 * Idempotent. No-ops on the neon path (that driver initializes lazily in the
 * Proxy getter and needs no warm-up) and when DATABASE_URL is unset (a dev
 * server may boot without a database; a real access later surfaces the error).
 */
export async function warmupDatabase(): Promise<void> {
  if (_warmed) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  if (resolveDriver(databaseUrl) !== 'postgres') return;

  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  setDb(drizzleNodePg(pool, { schema }));
  _warmed = true;
}
