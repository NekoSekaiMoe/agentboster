import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Postgres-backed KV store for self-hosted deployments.
 *
 * On Vercel the app uses Upstash Redis over HTTP (`lib/core/kv`). Self-hosted
 * deployments have no Upstash, so these two tables back the same small KV
 * surface the app actually uses (GET/SET/DEL/EXPIRE/SET-NX + a Lua
 * compare-and-delete, plus SADD/SREM/SMEMBERS/TTL for pair-code indexes).
 *
 * Expiry is lazy: reads filter on `expires_at > now()` and a periodic sweep
 * (see `lib/core/kv/pg-backend.ts` `sweepExpiredKv`) deletes stale rows. A
 * NULL `expires_at` means "no expiry".
 */
export const kvStore = pgTable(
  'kv_store',
  {
    key: text('key').primaryKey(),
    // Values are stored verbatim as text. This mirrors Upstash's storage
    // exactly: callers store both non-JSON strings (lock tokens, job ids,
    // base64 audio, the "1" dedup marker) and JSON.stringify'd objects
    // (config, skill metadata). The pg-backend `get()` reproduces Upstash's
    // read behavior — try JSON.parse, fall back to the raw string — so a
    // jsonb column would be wrong (bare tokens are not valid JSON).
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    expiresAtIdx: index('kv_store_expires_at_idx').on(table.expiresAt),
  }),
);

/**
 * Set members for the SADD/SREM/SMEMBERS surface (only `lib/auth/pair-code.ts`
 * uses this). Composite PK on (key, member); per-row expiry mirrors kvStore.
 */
export const kvSets = pgTable(
  'kv_sets',
  {
    key: text('key').notNull(),
    member: text('member').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.key, table.member] }),
    expiresAtIdx: index('kv_sets_expires_at_idx').on(table.expiresAt),
  }),
);

export type KvRow = typeof kvStore.$inferSelect;
export type NewKvRow = typeof kvStore.$inferInsert;
export type KvSetRow = typeof kvSets.$inferSelect;
export type NewKvSetRow = typeof kvSets.$inferInsert;
