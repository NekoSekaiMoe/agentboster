/**
 * Pre-push guard: perform the legacy `workspaces` → `project_sandboxes`
 * split BEFORE `drizzle-kit push` runs.
 *
 * Why this exists: the workspace split (legacy project↔sandbox `workspaces`
 * renamed to `project_sandboxes`, plus a NEW user-facing `workspaces`
 * table) is expressed as a hand-written, guarded migration
 * (lib/core/db/migrations/0039_m0a_workspace_split_replay.sql). But the
 * supported entries — vercel-postbuild.ts / self-host-migrate.ts — apply
 * the schema via `drizzle-kit push --force`, which NEVER executes migration
 * SQL files (only `drizzle-kit migrate` does). Push diffs live DB vs schema
 * BY TABLE NAME, so a DB still carrying the legacy `workspaces` table is
 * reconciled as an in-place ALTER against the NEW user-facing shape:
 *   - ADD COLUMN "owner_id" text NOT NULL (no default) fails on any
 *     non-empty legacy table ("contains null values"), and
 *   - drizzle-kit's pgPush wraps statement execution in
 *     `try/catch { console.error(e) }` — the failure is SWALLOWED and push
 *     exits 0, leaving the DB half-migrated (statements run one-by-one, no
 *     transaction). The postbuild then proceeds and migrate-workspaces.ts
 *     crashes on the still-legacy table ("column w.owner_id does not
 *     exist").
 *
 * Running this script first takes the rename off push's plate entirely:
 * afterwards the live DB has `project_sandboxes` and NO `workspaces`, so
 * push simply CREATEs the new user-facing table — no rename/column
 * conflict resolution involved.
 *
 * Handles three states, all idempotent:
 *   1. No `workspaces` table (fresh install, or split already applied)
 *      → no-op; push creates whatever is missing.
 *   2. `workspaces` already has the NEW shape (owner_id) → no-op.
 *   3. Legacy `workspaces` (has project_id):
 *      a. `project_sandboxes` absent → RENAME (mirrors 0039, including
 *         dropping the stray is_default that pre-fix 0037 may have added
 *         to the legacy table, and renaming the unique constraint to
 *         match the recorded snapshot).
 *      b. `project_sandboxes` present (drift left by a swallowed push
 *         failure: push created it empty, then choked on the ALTER) →
 *         copy legacy rows over (ON CONFLICT DO NOTHING on project_id),
 *         then DROP the legacy table so push can recreate `workspaces`
 *         with the new shape.
 *
 * Run by `self-host-migrate.ts` / `vercel-postbuild.ts` before
 * `drizzle-kit push --force`. Safe to run on every boot.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeRawSql, getRawQuery } from './db-raw-sql';

type SplitOutcome =
  | 'no-workspaces-table'
  | 'already-new-shape'
  | 'renamed'
  | 'merged-and-dropped';

/**
 * Ensure the legacy `workspaces` table (project ↔ sandbox bindings) has
 * been split off to `project_sandboxes`, leaving the `workspaces` name free
 * for `drizzle-kit push` to create with the new user-facing shape.
 * Returns a machine-readable outcome for logging/tests.
 */
export async function ensureWorkspaceSplit(): Promise<SplitOutcome> {
  const query = getRawQuery();

  const tables = await query<{
    workspaces: string | null;
    project_sandboxes: string | null;
  }>(`
    SELECT to_regclass('public.workspaces')::text AS workspaces,
           to_regclass('public.project_sandboxes')::text AS project_sandboxes
  `);
  if (!tables[0]?.workspaces) {
    // Fresh install (push creates both tables) or split already applied.
    return 'no-workspaces-table';
  }

  // Shape check: the NEW user-facing table has owner_id; the legacy
  // project-sandbox table has project_id. (A half-altered table that has
  // owner_id already is left for push to finish reconciling.)
  const shape = await query<{ has_owner: boolean; has_project: boolean }>(`
    SELECT bool_or(column_name = 'owner_id') AS has_owner,
           bool_or(column_name = 'project_id') AS has_project
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces'
  `);
  if (shape[0]?.has_owner || !shape[0]?.has_project) {
    return 'already-new-shape';
  }

  if (!tables[0].project_sandboxes) {
    // 3a. Clean rename — mirrors migration 0039. The stray is_default drop
    // covers DBs where a pre-fix 0037 added the column to the LEGACY table.
    await query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "is_default"`);
    await query(`ALTER TABLE "workspaces" RENAME TO "project_sandboxes"`);
    // The unique constraint keeps its original name through RENAME TABLE;
    // rename it to match the recorded snapshot. Guarded so a DB whose
    // constraint was already renamed (or never existed) doesn't fail.
    await query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.project_sandboxes'::regclass
            AND conname = 'workspaces_project_id_unique'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.project_sandboxes'::regclass
            AND conname = 'project_sandboxes_project_id_unique'
        ) THEN
          ALTER TABLE "project_sandboxes"
            RENAME CONSTRAINT "workspaces_project_id_unique"
            TO "project_sandboxes_project_id_unique";
        END IF;
      END $$
    `);
    console.log(
      '[ensure-workspace-split] renamed legacy "workspaces" table to "project_sandboxes"',
    );
    return 'renamed';
  }

  // 3b. Drift repair: project_sandboxes already exists (created empty by a
  // push run whose ALTER of the legacy table failed and was swallowed).
  // Merge the legacy rows, then drop the legacy table. ON CONFLICT +
  // guarded re-run make a crash between the two statements safe.
  const legacyCount = await query<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM "workspaces"
  `);
  const merged = await query<{ id: string }>(`
    INSERT INTO "project_sandboxes"
      (id, project_id, agent_id, name, sandbox_id, sandbox_type, status, created_at, updated_at)
    SELECT id, project_id, agent_id, name, sandbox_id, sandbox_type, status, created_at, updated_at
    FROM "workspaces"
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  await query(`DROP TABLE "workspaces"`);
  console.log(
    `[ensure-workspace-split] merged ${merged.length}/${legacyCount[0]?.count ?? 0} legacy workspaces row(s) into project_sandboxes and dropped the legacy table`,
  );
  return 'merged-and-dropped';
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
    throw new Error('[ensure-workspace-split] DATABASE_URL is required');
  }

  const outcome = await ensureWorkspaceSplit();
  if (outcome === 'no-workspaces-table' || outcome === 'already-new-shape') {
    // Quiet on steady-state boots — nothing to repair.
    console.log(`[ensure-workspace-split] no action needed (${outcome})`);
  }
}

if (isInvokedDirectly()) {
  // Structured so closeRawSql() ALWAYS completes before the process exits:
  // process.exit(1) inside .catch would kill the process before the
  // .finally could release the pg pool.
  void (async () => {
    let failed = false;
    try {
      await main();
    } catch (error) {
      console.error('[ensure-workspace-split] failed:', error);
      failed = true;
    } finally {
      await closeRawSql();
    }
    if (failed) {
      process.exitCode = 1;
    }
  })();
}
