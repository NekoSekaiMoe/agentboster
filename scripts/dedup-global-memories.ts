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
 * Retention semantics are identical to
 * lib/core/db/migrations/0038_global_key_partial_uniq.sql: keep the most
 * recently updated row per (user_id, project_id, memory_key) group among
 * global (workspace_id IS NULL) rows, tie-broken by highest id; plain `=`
 * comparisons match the index's NULL semantics (NULL memory_key rows stay
 * distinct and are never deduped).
 *
 * CASCADE SAFETY: long_term_memory_chunks.memory_id and both
 * memory_edges endpoint columns reference long_term_memories.id with
 * ON DELETE CASCADE (lib/core/db/schema/memory.ts), so a bare DELETE of a
 * duplicate would silently destroy its vector chunks and every graph edge
 * touching it — including edges OTHER memories point at it with. Instead,
 * before deleting a doomed row we re-point its dependents to the retained
 * row, all in ONE atomic statement (data-modifying CTE):
 *   - chunks: re-pointed wholesale (no unique constraint on
 *     (memory_id, chunk_index) — the schema only has a non-unique index).
 *   - edges: re-pointed per endpoint. Re-pointing can collide with
 *     memory_edges_unique_idx (src_memory_id, dst_memory_id, relation) —
 *     e.g. doomed→X duplicates retained→X — so per (new src, new dst,
 *     relation) we keep ONE survivor (preferring an edge that already has
 *     its final endpoints, then lowest edge id) and DELETE the colliding
 *     rest. Edges that would collapse into self-loops (e.g. an edge
 *     between two rows of the same duplicate group) are deleted too.
 *     Deleting a duplicate edge loses at most redundant graph weight; the
 *     surviving equivalent edge preserves connectivity.
 *
 * Why a single statement instead of BEGIN/COMMIT: db-raw-sql.ts exposes no
 * transaction helper, and the neon HTTP driver cannot span BEGIN..COMMIT
 * across separate .query() calls (each is a stateless request). One
 * data-modifying-CTE statement is an implicit transaction on both drivers
 * — strictly stronger atomicity than a multi-call transaction.
 *
 * Idempotent and guarded: no-ops when the table or the workspace_id column
 * does not exist yet (fresh installs run this before the first push), and
 * falls back to the plain 0038-style DELETE when the chunks/edges tables
 * are absent (schemas older than migration 0010/0018).
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
 * memory_key) group, re-pointing dependent chunks/edges to the retained
 * row first so the ON DELETE CASCADE cannot silently destroy them.
 * Returns the number of memory rows deleted.
 */
export async function dedupGlobalLongTermMemories(): Promise<number> {
  const query = getRawQuery();

  // Guard: fresh installs run this BEFORE `drizzle-kit push` creates the
  // table — nothing to dedup yet.
  const tables = await query<{
    ltm: string | null;
    chunks: string | null;
    edges: string | null;
  }>(`
    SELECT to_regclass('public.long_term_memories')::text AS ltm,
           to_regclass('public.long_term_memory_chunks')::text AS chunks,
           to_regclass('public.memory_edges')::text AS edges
  `);
  if (!tables[0]?.ltm) {
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

  // Guard: schemas predating migrations 0010/0018 have no dependent
  // tables to re-point — fall back to the plain 0038-style DELETE.
  if (!tables[0].chunks || !tables[0].edges) {
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

  // Cascade-safe dedup as ONE atomic statement. Stages:
  //   ranked   — window-rank global rows within each (user, project, key)
  //              group; NULL component values are excluded to match the
  //              original `=` semantics (NULLs never duplicated).
  //   remap    — every row in a duplicate group → the retained row id.
  //   doomed   — the non-retained rows to delete.
  //   remapped — every memory_edges row as it would look after re-pointing
  //              doomed endpoints to the retained memory.
  //   survivors — one winner per (new src, new dst, relation) so the
  //              memory_edges_unique_idx cannot be violated; self-loops
  //              introduced by the re-point never survive.
  // Then: re-point chunks, re-point surviving touched edges, delete
  // colliding/self-loop touched edges, delete the doomed memories. All
  // data-modifying CTEs share one snapshot; the ON DELETE CASCADE that
  // fires with `deleted` finds no remaining dependents.
  const deleted = await query<{ id: string }>(`
    WITH ranked AS (
      SELECT id,
             COUNT(*) OVER (
               PARTITION BY user_id, project_id, memory_key
             ) AS group_size,
             FIRST_VALUE(id) OVER (
               PARTITION BY user_id, project_id, memory_key
               ORDER BY updated_at DESC, id DESC
             ) AS retained_id
      FROM long_term_memories
      WHERE workspace_id IS NULL
        AND user_id IS NOT NULL
        AND project_id IS NOT NULL
        AND memory_key IS NOT NULL
    ),
    remap AS (
      SELECT id, retained_id
      FROM ranked
      WHERE group_size > 1
    ),
    doomed AS (
      SELECT id AS doomed_id, retained_id
      FROM remap
      WHERE id <> retained_id
    ),
    remapped AS (
      SELECT e.id,
             COALESCE(ms.retained_id, e.src_memory_id) AS new_src,
             COALESCE(md.retained_id, e.dst_memory_id) AS new_dst,
             e.relation,
             (ds.doomed_id IS NOT NULL OR dd.doomed_id IS NOT NULL) AS touched
      FROM memory_edges e
      LEFT JOIN remap ms ON ms.id = e.src_memory_id
      LEFT JOIN remap md ON md.id = e.dst_memory_id
      LEFT JOIN doomed ds ON ds.doomed_id = e.src_memory_id
      LEFT JOIN doomed dd ON dd.doomed_id = e.dst_memory_id
    ),
    survivors AS (
      SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY new_src, new_dst, relation
                 ORDER BY touched, id
               ) AS edge_rn
        FROM remapped
        WHERE new_src <> new_dst
      ) s
      WHERE edge_rn = 1
    ),
    repoint_chunks AS (
      UPDATE long_term_memory_chunks c
      SET memory_id = d.retained_id
      FROM doomed d
      WHERE c.memory_id = d.doomed_id
    ),
    repoint_edges AS (
      UPDATE memory_edges e
      SET src_memory_id = r.new_src,
          dst_memory_id = r.new_dst
      FROM remapped r
      WHERE e.id = r.id
        AND r.touched
        AND r.id IN (SELECT id FROM survivors)
    ),
    drop_edges AS (
      DELETE FROM memory_edges e
      USING remapped r
      WHERE e.id = r.id
        AND r.touched
        AND r.id NOT IN (SELECT id FROM survivors)
    ),
    deleted AS (
      DELETE FROM long_term_memories m
      USING doomed d
      WHERE m.id = d.doomed_id
      RETURNING m.id AS id
    )
    SELECT id FROM deleted
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
  // Structured so closeRawSql() ALWAYS completes before the process exits:
  // the previous form (process.exit(1) inside .catch) killed the process
  // before the .finally could release the pg pool.
  void (async () => {
    let failed = false;
    try {
      await main();
    } catch (error) {
      console.error('[dedup-global-memories] failed:', error);
      failed = true;
    } finally {
      await closeRawSql();
    }
    if (failed) {
      process.exitCode = 1;
    }
  })();
}
