import { resolveDriver, type DbDriver } from './index';

/**
 * Detect which atomic-write primitive the active database driver supports.
 *
 * The two drivers behind `lib/core/db`'s singleton Proxy have DIFFERENT and
 * NON-OVERLAPPING atomic-write APIs:
 *
 *   - neon-http (Vercel): exposes `db.batch([...])` — routes through
 *     Neon's HTTP transaction API (one server-side Postgres transaction,
 *     all-or-nothing via the `Neon-Batch-Isolation-Level` header). Does
 *     NOT expose `db.transaction(callback)` — it throws at runtime
 *     (`"No transactions support in neon-http driver"`).
 *
 *   - node-postgres (self-hosted): exposes `db.transaction(callback)` —
 *     a real interactive transaction with a `tx` you can read/write
 *     through. Does NOT expose `db.batch` — it is `undefined` on
 *     `NodePgDatabase` (throws `TypeError` if called).
 *
 * There is no single API that works on both. Callers that need atomic
 * multi-write must branch on this helper and use the matching primitive.
 *
 * `db` is the Proxy singleton from `./index`; both primitives are available
 * on the *type* (the Proxy is typed as the neon driver) but only one is
 * present at runtime — so TypeScript cannot catch a mismatch. This helper
 * exists to make the runtime choice explicit.
 */
export function atomicWriteMode(): DbDriver {
  return resolveDriver(process.env.DATABASE_URL ?? '');
}
