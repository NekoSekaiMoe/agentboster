/**
 * Raw-SQL executor for standalone host scripts (migrations, extension setup).
 *
 * These scripts run via `tsx` on the host — they are NEVER part of the
 * workflow bundle, so unlike `lib/core/db/index.ts` they may import `pg` at
 * the top level. This helper mirrors the driver-selection logic in
 * `lib/core/db/index.ts` (`resolveDriver`) so scripts and the app agree on
 * which backend a given DATABASE_URL targets.
 *
 * Exposes a module-singleton `getRawSql()` returning a tagged-template `sql`
 * function compatible with both:
 *   - `@neondatabase/serverless` `neon()` (Vercel / *.neon.tech)
 *   - `pg` Pool (self-hosted Postgres over TCP)
 *
 * Call `closeRawSql()` before the script exits so a pg-backed run releases
 * the pool instead of hanging on an open connection (no-op for neon).
 */
import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';

import { isVercel } from '../lib/extra/deploy';

type RawSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

/**
 * Positional-parameter query executor: `query(text, params) => rows`.
 * Both neon() and pg Pool expose a `.query()` with this shape, but neon's
 * returns `{ rows }`-less arrays via its own overload while pg returns a
 * `QueryResult`. This helper normalizes both to a plain `rows` array.
 */
export type RawQuery = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

function resolveDriver(databaseUrl: string): 'neon' | 'postgres' {
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
    // Unparseable URL — fall through to the deployment-mode default below.
  }
  // Deployment-mode default goes through the deploy hub (AGENTS.md:
  // never inline process.env.VERCEL checks).
  return isVercel ? 'neon' : 'postgres';
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL env var is not set');
  }
  return databaseUrl;
}

let _pool: Pool | null = null;
let _sql: RawSql | null = null;

/**
 * Lazily build (and memoize) the raw-SQL executor for this process.
 */
export function getRawSql(): RawSql {
  if (_sql) return _sql;

  const databaseUrl = requireDatabaseUrl();

  if (resolveDriver(databaseUrl) === 'neon') {
    _sql = neon(databaseUrl) as unknown as RawSql;
    return _sql;
  }

  _pool = new Pool({ connectionString: databaseUrl });
  _sql = (strings, ...values) => {
    // Convert the tagged-template into a parameterized pg query: interleave
    // the literal chunks with $1..$n placeholders.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      text += `$${i + 1}${strings[i + 1]}`;
    }
    // biome-ignore lint/style/noNonNullAssertion: _pool is set on this branch.
    return _pool!.query(text, values).then((result) => result.rows);
  };
  return _sql;
}

let _query: RawQuery | null = null;

/**
 * Lazily build (and memoize) a positional-parameter query executor for this
 * process. Use this for scripts that build SQL with `$1..$n` placeholders
 * (e.g. batched migrations) rather than tagged templates.
 */
export function getRawQuery(): RawQuery {
  if (_query) return _query;

  const databaseUrl = requireDatabaseUrl();

  if (resolveDriver(databaseUrl) === 'neon') {
    const sql = neon(databaseUrl);
    _query = (async <T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) => {
      // neon's `.query(text, params)` returns the rows array directly.
      return (await sql.query(text, params)) as T[];
    }) as RawQuery;
    return _query;
  }

  _pool ??= new Pool({ connectionString: databaseUrl });
  const pool = _pool;
  _query = (async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    const result = await pool.query(text, params);
    return result.rows as T[];
  }) as RawQuery;
  return _query;
}

/**
 * Release the pg pool (no-op for neon). Safe to call multiple times.
 */
export async function closeRawSql(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  _sql = null;
  _query = null;
}
