/**
 * One-shot data migration: backfill `user_vault_entries` from the legacy
 * shared `vault_entries` table.
 *
 * Context: migration `0030_multi_user_isolation_and_usage.sql` introduced
 * `user_vault_entries` (per-user private key store) and rewired `/api/vault/*`
 * to read/write it exclusively, but did NOT copy over historical rows from
 * `vault_entries`. After that schema migration, any previously-stored user
 * key became invisible (returns "not found" from the vault routes) until this
 * backfill runs.
 *
 * Ownership mapping: `vault_entries.created_by_user_id` → `user_id`. Rows
 * with no recorded owner are skipped (they cannot be attributed to a user;
 * they remain in `vault_entries` as an audit trail and can be investigated
 * manually if needed).
 *
 * Idempotent: relies on the `user_vault_entries_user_id_key_idx` UNIQUE
 * `(user_id, key)` index. A re-run uses `ON CONFLICT DO NOTHING` so already-
 * migrated rows are skipped. Safe to run repeatedly and on every boot.
 *
 * Run by `self-host-migrate.ts` / `vercel-postbuild.ts` after `drizzle-kit push`
 * (the table must exist first).
 */
import { closeRawSql, getRawQuery } from './db-raw-sql';

type BackfillCount = { migrated: number; skipped_no_owner: number };

async function backfillVaultEntriesToUserScoped(): Promise<BackfillCount> {
  const query = getRawQuery();

  // Insert historical vault entries into user_vault_entries, mapping the
  // created_by_user_id (or updated_by_user_id as fallback) to user_id.
  // ON CONFLICT (user_id, key) DO NOTHING makes this idempotent — rows
  // already migrated or since-written via /api/vault/* are preserved.
  //
  // NOTE: this assumes user_vault_entries exists (it's created by the
  // 0030 schema migration). If you run this before that migration lands,
  // the INSERT will fail with a relation-not-found error.
  const result = await query<{ migrated: number; skipped_no_owner: number }>(`
    WITH source AS (
      SELECT
        COALESCE(created_by_user_id, updated_by_user_id) AS user_id,
        key,
        encrypted_value,
        nonce,
        created_at,
        updated_at
      FROM vault_entries
      WHERE COALESCE(created_by_user_id, updated_by_user_id) IS NOT NULL
    ),
    inserted AS (
      INSERT INTO user_vault_entries (user_id, key, encrypted_value, nonce, created_at, updated_at)
      SELECT user_id, key, encrypted_value, nonce, created_at, updated_at FROM source
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING 1
    ),
    skipped AS (
      SELECT COUNT(*)::int AS n
      FROM vault_entries
      WHERE COALESCE(created_by_user_id, updated_by_user_id) IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM inserted) AS migrated,
      (SELECT n FROM skipped) AS skipped_no_owner
  `);

  return result[0] ?? { migrated: 0, skipped_no_owner: 0 };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('[migrate-vault] DATABASE_URL is required');
  }

  const { migrated, skipped_no_owner } =
    await backfillVaultEntriesToUserScoped();

  // Only log when something actually happened — keeps boot output quiet on
  // steady-state restarts (matches the message-versions migration's style).
  if (migrated > 0 || skipped_no_owner > 0) {
    console.log(
      `[migrate-vault] backfilled ${migrated} vault entries to user_vault_entries` +
        (skipped_no_owner > 0
          ? `; skipped ${skipped_no_owner} unattributed rows (no created_by_user_id)`
          : ''),
    );
  } else {
    console.log('[migrate-vault] no vault entries to backfill');
  }
}

main()
  .catch((error) => {
    console.error('[migrate-vault] failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await closeRawSql();
  });
