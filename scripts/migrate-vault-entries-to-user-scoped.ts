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
 * Ownership mapping — IMPORTANT: `vault_entries` is a SYSTEM-level table
 * (MCP OAuth bundles, knowledge-provider API keys) written exclusively via
 * {@link upsertVaultEntry} by `lib/mcp/oauth-store.ts` and
 * `lib/knowledge/index.ts`. Its `created_by_user_id` / `updated_by_user_id`
 * columns are AUDIT fields only ("which user triggered the system write"),
 * NOT an ownership claim — see the JSDoc on `upsertVaultEntry`: "The userId
 * argument is audit-only — system entries are not owned by any user."
 *
 * A previous version of this script derived the new owner from
 * `COALESCE(created_by_user_id, updated_by_user_id)`. That would copy a
 * system secret into `user_vault_entries(user_id = <triggering user>)`,
 * making a shared/system credential privately visible to that one user — a
 * privilege leak, plus a duplicate of a row that still lives in
 * `vault_entries`. We no longer do that.
 *
 * Correct behavior: there is no trustworthy per-user owner mapping in
 * `vault_entries`, so NOTHING is migrated automatically. Legacy rows are
 * left in place as an audit trail; this script is now a safe no-op that
 * reports how many unmigrated legacy rows exist (for operator triage).
 * Idempotent and safe to run on every boot.
 *
 * Run by `self-host-migrate.ts` / `vercel-postbuild.ts` after `drizzle-kit push`
 * (the table must exist first).
 */
import { closeRawSql, getRawQuery } from './db-raw-sql';

type BackfillCount = {
  migrated: number;
  skipped_no_trusted_owner: number;
};

async function backfillVaultEntriesToUserScoped(): Promise<BackfillCount> {
  const query = getRawQuery();

  // Count legacy system rows for operator visibility. Nothing is migrated:
  // `vault_entries.created_by_user_id` / `updated_by_user_id` are audit
  // fields, not ownership claims (see the module docstring), so there is no
  // trustworthy per-user owner mapping and auto-migrating would leak system
  // secrets into a single user's private vault. Legacy rows stay here as an
  // audit trail; operators must map ownership manually if a legitimate
  // private entry was ever written to the legacy table.
  const result = await query<{ skipped_no_trusted_owner: number }>(`
    SELECT COUNT(*)::int AS skipped_no_trusted_owner
    FROM vault_entries
    WHERE COALESCE(created_by_user_id, updated_by_user_id) IS NOT NULL
  `);

  return { migrated: 0, skipped_no_trusted_owner: result[0]?.skipped_no_trusted_owner ?? 0 };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('[migrate-vault] DATABASE_URL is required');
  }

  const { migrated, skipped_no_trusted_owner } =
    await backfillVaultEntriesToUserScoped();

  // Only log when something actually happened — keeps boot output quiet on
  // steady-state restarts (matches the message-versions migration's style).
  if (migrated > 0 || skipped_no_trusted_owner > 0) {
    console.log(
      `[migrate-vault] backfilled ${migrated} vault entries to user_vault_entries` +
        (skipped_no_trusted_owner > 0
          ? `; ${skipped_no_trusted_owner} legacy system rows retained in vault_entries for manual review (no trusted owner mapping)`
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
