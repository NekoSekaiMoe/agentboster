/**
 * Postgres-backed KV backend for self-hosted deployments.
 *
 * Implements the subset of the Upstash `Redis` surface the app actually uses,
 * with byte-for-byte compatible return contracts so `lib/core/kv/index.ts` can
 * swap this in for Upstash off-Vercel with zero changes at the call sites:
 *
 *   get / set (nx, ex, px) / del / expire / eval (release-lock CAS) /
 *   sadd / srem / smembers / ttl
 *
 * Contract details that MUST be preserved (verified against call sites):
 *  - `get(key)` reproduces Upstash's read behavior: values are stored as raw
 *    text; on read we try `JSON.parse` and fall back to the raw string. So
 *    `set(k, JSON.stringify(obj))` then `get(k)` returns the OBJECT (config.ts
 *    relies on this), while a bare token round-trips as a string (lock.ts).
 *  - `set(..., { nx: true })` returns the string `'OK'` on success and `null`
 *    on conflict (lock.ts and bot/index.ts compare `=== 'OK'`).
 *  - `set(...)` without nx returns `'OK'`.
 *  - `eval(RELEASE_LOCK_SCRIPT, [key], [token])` performs a compare-and-delete.
 *  - `ttl(key)` returns remaining seconds, `-2` if missing, `-1` if no expiry
 *    (matches Redis TTL semantics; pair-code.ts only checks `> 0`).
 *
 * IMPORTANT: this module is statically reachable from the workflow bundle
 * (via `lib/core/kv/index.ts` ← config.ts ← workflow context). It must NOT use
 * top-level `node:*` imports. It only touches the drizzle `db` (already warmed
 * by instrumentation) and drizzle operators, which are bundle-safe.
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { kvSets, kvStore } from '@/lib/core/db/schema/kv';

type SetOptions = {
  nx?: boolean;
  xx?: boolean;
  ex?: number; // expiry in seconds
  px?: number; // expiry in milliseconds
};

/** Compute an absolute expiry Date from ex (seconds) / px (millis), or null. */
export function expiryFromOptions(options?: SetOptions): Date | null {
  if (!options) return null;
  if (typeof options.px === 'number') {
    return new Date(Date.now() + options.px);
  }
  if (typeof options.ex === 'number') {
    return new Date(Date.now() + options.ex * 1000);
  }
  return null;
}

/** A live (non-expired) row predicate: expires_at IS NULL OR expires_at > now(). */
function liveRow() {
  return or(isNull(kvStore.expiresAt), gt(kvStore.expiresAt, new Date()));
}

/**
 * GET — returns the parsed value, or null if missing/expired.
 * Mirrors Upstash: raw text is JSON.parse'd when possible, else returned as-is.
 */
export async function pgGet<T = unknown>(key: string): Promise<T | null> {
  const rows = await db
    .select({ value: kvStore.value })
    .from(kvStore)
    .where(and(eq(kvStore.key, key), liveRow()))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return parseStoredValue(row.value) as T;
}

export function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Serialize a value for storage the way Upstash does — objects as JSON, */
/** primitives coerced to their string form (callers already JSON.stringify). */
export function serializeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * SET — with optional nx / ex / px. Returns 'OK' on write, null on nx conflict.
 */
export async function pgSet(
  key: string,
  value: unknown,
  options?: SetOptions,
): Promise<'OK' | null> {
  const stored = serializeValue(value);
  const expiresAt = expiryFromOptions(options);
  const now = new Date();

  if (options?.nx) {
    // SET NX with expired-key reclamation, atomic in a single statement.
    //
    // INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE <row is expired>:
    //  - key absent            → INSERT happens
    //  - key present & expired  → guarded UPDATE fires (reclaim the stale key)
    //  - key present & live     → guarded UPDATE matches nothing → no row
    //
    // Postgres exposes whether a returned row came from the INSERT or the
    // UPDATE via the system column `xmax`: it is 0 for a freshly inserted row
    // and non-zero for an updated one. Both count as "we own the key now" for
    // NX purposes (a reclaimed expired key is ours), so any returned row means
    // success; an empty result means a live key blocked us → conflict.
    //
    // This avoids comparing timestamps (pg truncates sub-millisecond precision,
    // which made an `updatedAt === now` check unreliable).
    const inserted = await db
      .insert(kvStore)
      .values({ key, value: stored, expiresAt, updatedAt: now })
      .onConflictDoUpdate({
        target: kvStore.key,
        set: { value: stored, expiresAt, updatedAt: now },
        setWhere: or(isNull(kvStore.expiresAt), lte(kvStore.expiresAt, now)),
      })
      .returning({ key: kvStore.key });

    return inserted.length > 0 ? 'OK' : null;
  }

  await db
    .insert(kvStore)
    .values({ key, value: stored, expiresAt, updatedAt: now })
    .onConflictDoUpdate({
      target: kvStore.key,
      set: { value: stored, expiresAt, updatedAt: now },
    });
  return 'OK';
}

/** DEL — deletes one or more keys. Returns the number removed. */
export async function pgDel(...keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const deleted = await db
    .delete(kvStore)
    .where(inArray(kvStore.key, keys))
    .returning({ key: kvStore.key });
  return deleted.length;
}

/** EXPIRE — set a TTL (seconds) on an existing key. Returns 1/0 like Redis. */
export async function pgExpire(key: string, seconds: number): Promise<number> {
  const expiresAt = new Date(Date.now() + seconds * 1000);
  const updated = await db
    .update(kvStore)
    .set({ expiresAt })
    .where(and(eq(kvStore.key, key), liveRow()))
    .returning({ key: kvStore.key });
  return updated.length > 0 ? 1 : 0;
}

/**
 * EVAL — only the release-lock compare-and-delete script is ever passed here
 * (see lib/core/kv/lock.ts). Rather than embed a Lua interpreter, we match the
 * exact CAS semantics: delete key iff its current value equals the token.
 * Returns 1 on delete, 0 otherwise (the Lua script's return value).
 */
export async function pgEval(
  _script: string,
  keys: string[],
  args: string[],
): Promise<number> {
  const key = keys[0];
  const token = args[0];
  if (!key || token === undefined) return 0;

  const deleted = await db
    .delete(kvStore)
    .where(and(eq(kvStore.key, key), eq(kvStore.value, token)))
    .returning({ key: kvStore.key });
  return deleted.length > 0 ? 1 : 0;
}

/** SADD — add a member to a set. Returns count of newly-added members. */
export async function pgSadd(
  key: string,
  ...members: string[]
): Promise<number> {
  if (members.length === 0) return 0;
  const rows = members.map((member) => ({ key, member }));
  const inserted = await db
    .insert(kvSets)
    .values(rows)
    .onConflictDoNothing({ target: [kvSets.key, kvSets.member] })
    .returning({ member: kvSets.member });
  return inserted.length;
}

/** SREM — remove members from a set. Returns count removed. */
export async function pgSrem(
  key: string,
  ...members: string[]
): Promise<number> {
  if (members.length === 0) return 0;
  const deleted = await db
    .delete(kvSets)
    .where(and(eq(kvSets.key, key), inArray(kvSets.member, members)))
    .returning({ member: kvSets.member });
  return deleted.length;
}

/** SMEMBERS — return the live members of a set. */
export async function pgSmembers(key: string): Promise<string[]> {
  const rows = await db
    .select({ member: kvSets.member })
    .from(kvSets)
    .where(
      and(
        eq(kvSets.key, key),
        or(isNull(kvSets.expiresAt), gt(kvSets.expiresAt, new Date())),
      ),
    );
  return rows.map((r) => r.member);
}

/**
 * TTL — remaining seconds. Redis semantics: -2 if the key doesn't exist,
 * -1 if it exists with no expiry, else the remaining whole seconds.
 *
 * pair-code.ts applies this to a `kvStore` key (the pair code itself), so we
 * read from kvStore, not kvSets.
 */
export async function pgTtl(key: string): Promise<number> {
  const rows = await db
    .select({ expiresAt: kvStore.expiresAt })
    .from(kvStore)
    .where(and(eq(kvStore.key, key), liveRow()))
    .limit(1);

  const row = rows[0];
  if (!row) return -2;
  if (!row.expiresAt) return -1;
  const remainingMs = row.expiresAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/**
 * Sweep expired rows from both KV tables. Lazy expiry (via `liveRow()` on
 * reads) keeps behavior correct without this, but the sweep bounds table
 * growth. Call it opportunistically (e.g. from a periodic tick) — it is safe
 * to run concurrently. Returns the number of rows removed across both tables.
 */
export async function sweepExpiredKv(): Promise<number> {
  const now = new Date();
  const [store, sets] = await Promise.all([
    db
      .delete(kvStore)
      .where(
        and(sql`${kvStore.expiresAt} is not null`, lte(kvStore.expiresAt, now)),
      )
      .returning({ key: kvStore.key }),
    db
      .delete(kvSets)
      .where(
        and(sql`${kvSets.expiresAt} is not null`, lte(kvSets.expiresAt, now)),
      )
      .returning({ member: kvSets.member }),
  ]);
  return store.length + sets.length;
}
