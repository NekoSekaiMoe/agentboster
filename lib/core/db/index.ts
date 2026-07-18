import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { isVercel } from '@/lib/extra/deploy';
import * as schema from './schema';

/**
 * Dual-driver database layer.
 *
 * The `db` export is a SYNCHRONOUS Proxy consumed by ~50 call sites as
 * `db.select()...`. It must stay synchronous.
 *
 * Two drivers, chosen by DATABASE_URL shape (see `resolveDriver`):
 *
 *  - neon-http (`@neondatabase/serverless` + `drizzle-orm/neon-http`) —
 *    fetch-based, no `node:*` deps, SAFE to import at the top level here even
 *    though this module is statically reachable from the workflow bundle (via
 *    persist.ts → db/chat.ts → here). It initializes lazily and synchronously
 *    inside the Proxy getter, so the neon path needs no warm-up.
 *
 *  - node-postgres (`pg` + `drizzle-orm/node-postgres`) — talks raw TCP and
 *    pulls in `node:net` / `node:tls`. CRITICAL: `pg` must NEVER be referenced
 *    from this file, not even via `await import('pg')`. The workflow bundler
 *    resolves the static `'pg'` specifier, follows the package, sees its
 *    `node:*` deps, and HARD-FAILS `yarn build` — the `await import()` trick
 *    only hides Node BUILT-IN specifiers (`node:fs` etc.), not third-party
 *    packages that transitively require them.
 *
 *    So the pg driver lives entirely in `./pg-driver.ts`, which is imported
 *    ONLY from `instrumentation.ts` (host process, never reachable from a
 *    workflow body). It builds the driver and injects it here via `setDb()`.
 *    Next.js awaits `register()` before serving traffic, so by the time the
 *    sync Proxy getter is first hit on the pg path, `_db` is already set.
 */

type DrizzleDb = ReturnType<typeof drizzleNeon<typeof schema>>;

let _db: DrizzleDb | null = null;

export type DbDriver = 'neon' | 'postgres';

/**
 * Pick a driver from DATABASE_URL. Neon serverless endpoints live on
 * `*.neon.tech`; anything else is assumed to be a stock Postgres server
 * reachable over TCP. An explicit `DB_DRIVER=neon|postgres` overrides the
 * heuristic for the rare case of a Neon-compatible proxy on a custom host.
 */
export function resolveDriver(databaseUrl: string): DbDriver {
  const override = process.env.DB_DRIVER?.trim().toLowerCase();
  if (override === 'neon' || override === 'postgres') {
    return override;
  }

  try {
    const { hostname } = new URL(databaseUrl);
    if (hostname.endsWith('.neon.tech') || hostname === 'db.neon.tech') {
      return 'neon';
    }
  } catch {
    // Fall through to the deployment-mode default on an unparseable URL.
  }

  // On Vercel without a recognizable Neon host, default to neon-http (the
  // platform integration always provisions a Neon endpoint). Off Vercel,
  // default to node-postgres.
  return isVercel ? 'neon' : 'postgres';
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL env var is not set');
  }
  return databaseUrl;
}

function initNeon(databaseUrl: string): DrizzleDb {
  const sql = neon(databaseUrl);
  return drizzleNeon(sql, { schema });
}

/**
 * Inject a pre-built drizzle instance. Called by `./pg-driver.ts`'s
 * `warmupDatabase()` (host-only) for the node-postgres path. Idempotent-ish:
 * the last writer wins, but warm-up runs once at process start.
 *
 * The parameter is typed loosely because the node-postgres drizzle instance is
 * a different concrete type than the neon one; they are structurally
 * interchangeable across our query surface.
 */
export function setDb(instance: unknown): void {
  _db = instance as DrizzleDb;
}

export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    if (!_db) {
      const databaseUrl = requireDatabaseUrl();
      const driver = resolveDriver(databaseUrl);
      if (driver === 'neon') {
        // neon-http is fetch-based — safe to initialize synchronously here.
        _db = initNeon(databaseUrl);
      } else {
        // node-postgres must have been pre-warmed and injected via setDb() by
        // instrumentation.ts → pg-driver.ts. Reaching here means warm-up did
        // not run (DB accessed before the server started, or instrumentation
        // is disabled).
        throw new Error(
          'Postgres driver not initialized. Self-hosted deployments must run ' +
            'the instrumentation warm-up (instrumentation.ts → pg-driver). ' +
            'This usually means the DB was accessed before the Next.js server ' +
            'started, or instrumentation is disabled.',
        );
      }
    }
    return Reflect.get(_db, prop, receiver);
  },
});

export { schema };
