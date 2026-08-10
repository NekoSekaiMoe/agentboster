/**
 * Pre-push dedup for long_term_memories global rows.
 *
 * Why this exists: `drizzle-kit push --force` (vercel-postbuild.ts /
 * self-host-migrate.ts) creates the partial unique index
 * `long_term_memories_user_project_key_global_uniq` directly against
 * existing data. Deployments that predate the index can carry duplicate
 * global rows (workspace_id IS NULL) per (user_id, project_id, memory_key),
 * and index creation then FAILS. The dedup DELETE used to live only in
 * migration file 0038 — which `push` never runs — so the cleanup must happen
 * BEFORE the push step, here.
 *
 * Semantics are identical to lib/core/db/migrations/0038_global_key_partial_uniq.sql:
 * keep the most recently updated row per (user_id, project_id, memory_key)
 * group among global (workspace_id IS NULL) rows; plain `=` comparisons
 * match the index's NULL semantics.
 *
 * Idempotent and guarded: no-ops when the table or the workspace_id column
 * does not exist yet (fresh installs run this before the first push).
 *
 * Also imported by migrate-workspaces.ts, which re-runs the same dedup
 * before its backfill for defense in depth. The auto-run main() at the
 * bottom only executes when the script is invoked directly
 * (`npx tsx scripts/dedup-global-memories.ts`), not on import.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeRawSql, getRawQuery } from './db-raw-sql';

/**
 * Delete duplicate global (workspace_id IS NULL) long_term_memories rows,
 * keeping the most recently updated row per (user_id, project_id,
 * memory_key) group. Returns the number of rows deleted.
 */
export async function dedupGlobalLongTermMemories(): Promise<number> {
  const query = getRawQuery();

  // Guard: fresh installs run this BEFORE `drizzle-kit push` creates the
  // table — nothing to dedup yet.
  const table = await query<{ reg: string | null }>(`
    SELECT to_regclass('public.long_term_memories')::text AS reg
  `);
  if (!table[0]?.reg) {
    return 0;
  }

  // Guard: pre-workspace schemas lack the column the dedup filters on.
  const column = await query<{ count: number }>(`
    SELECT COUNT(*)::int AS count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'long_term_memories'
      AND column_name = 'workspace_id'
  `);
  if (!column[0]?.count) {
    return 0;
  }

  // Same DELETE ... USING semantics as migration 0038.
  const deleted = await query<{ id: string }>(`
    DELETE FROM "long_term_memories" a
    USING "long_term_memories" b
    WHERE a."workspace_id" IS NULL
      AND b."workspace_id" IS NULL
      AND a."user_id" = b."user_id"
      AND a."project_id" = b."project_id"
      AND a."memory_key" = b."memory_key"
      AND (a."updated_at" < b."updated_at"
           OR (a."updated_at" = b."updated_at" AND a."id" < b."id"))
    RETURNING a."id" AS id
  `);
  return deleted.length;
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // argv[1] may be relative to the cwd (`npx tsx scripts/...`), so
    // resolve it before comparing against this module's absolute path.
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('[dedup-global-memories] DATABASE_URL is required');
  }

  const deleted = await dedupGlobalLongTermMemories();
  if (deleted > 0) {
    console.log(
      `[dedup-global-memories] deleted ${deleted} duplicate global long_term_memories row(s)`,
    );
  } else {
    console.log('[dedup-global-memories] no duplicates found');
  }
}

if (isInvokedDirectly()) {
  main()
    .catch((error) => {
      console.error('[dedup-global-memories] failed:', error);
      process.exit(1);
    })
    .finally(async () => {
      await closeRawSql();
    });
}
