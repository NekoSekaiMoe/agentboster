import { spawn } from 'node:child_process';

/**
 * Self-hosted database migration.
 *
 * The Vercel path (`scripts/vercel-postbuild.ts`) only runs migrations when
 * `VERCEL=1 && VERCEL_ENV=production`, so a self-hosted deployment never
 * migrates through it. This script is the self-hosted equivalent: run it once
 * on container/host startup (see the Dockerfile CMD / docker-compose command)
 * before `next start`.
 *
 * It performs the same three steps as the Vercel postbuild, in the same order:
 *   1. ensure the pgvector extension exists (knowledge/memory tsvector columns)
 *   2. push the Drizzle schema (creates kv_store / kv_sets and any new tables)
 *   3. run the one-shot message-version data migration (idempotent)
 *
 * All three are driver-agnostic: drizzle-kit reads DATABASE_URL directly, and
 * the two tsx scripts use `scripts/db-raw-sql.ts`, which auto-selects the neon
 * or pg driver by URL shape (same logic as `lib/core/db`).
 *
 * Idempotent: `drizzle-kit push` is a no-op when the schema already matches,
 * pgvector uses `CREATE EXTENSION IF NOT EXISTS`, and the version migration
 * skips already-migrated rows. Safe to run on every boot.
 */

function runCommand(command: string, args: string[] = []) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(' ')} exited with code ${code}`),
      );
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('[self-host-migrate] DATABASE_URL is required');
  }

  console.log('[self-host-migrate] ensuring pgvector extension');
  await runCommand('npx', ['tsx', 'scripts/ensure-vector-extension.ts']);

  // MUST run before `drizzle-kit push --force`: push creates the partial
  // unique index long_term_memories_user_project_key_global_uniq directly
  // against existing data, which fails on duplicate global rows. The dedup
  // DELETE in migration 0038 is never executed by push, so clean up first.
  // No-ops when the table/column doesn't exist yet (fresh installs).
  console.log(
    '[self-host-migrate] deduplicating global long_term_memories rows',
  );
  await runCommand('npx', ['tsx', 'scripts/dedup-global-memories.ts']);

  console.log('[self-host-migrate] pushing Drizzle schema');
  await runCommand('npx', ['drizzle-kit', 'push', '--force']);

  console.log(
    '[self-host-migrate] migrating message versions to unified model',
  );
  await runCommand('npx', ['tsx', 'scripts/migrate-message-versions.ts']);

  console.log(
    '[self-host-migrate] backfilling user_vault_entries from legacy vault_entries',
  );
  await runCommand('npx', [
    'tsx',
    'scripts/migrate-vault-entries-to-user-scoped.ts',
  ]);

  console.log(
    '[self-host-migrate] introducing user workspaces + backfilling workspace_id',
  );
  await runCommand('npx', ['tsx', 'scripts/migrate-workspaces.ts']);

  // Best-effort: the backfill is idempotent and safe to re-run on the next
  // boot, so a failure here must not fail the schema migration itself.
  try {
    console.log('[self-host-migrate] backfilling canonical Trace storage');
    await runCommand('npx', ['tsx', 'scripts/backfill-traces.ts']);
  } catch (error) {
    console.warn(
      '[self-host-migrate] canonical Trace backfill failed (continuing):',
      error instanceof Error ? error.message : String(error),
    );
  }

  console.log('[self-host-migrate] database schema is up to date');
}

main().catch((error) => {
  console.error('[self-host-migrate] failed:', error);
  process.exit(1);
});
