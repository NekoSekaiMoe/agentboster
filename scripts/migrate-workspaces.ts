/**
 * One-shot data migration: introduce user-facing workspaces and backfill
 * `workspace_id` across sessions / agent_tasks / long_term_memories.
 *
 * Context: the new `workspaces` table (user-facing workspace owning a
 * long-lived LXC container + memories) was added alongside renaming the
 * legacy `workspaces` table to `project_sandboxes`. Existing rows in
 * `sessions`, `agent_tasks`, and `long_term_memories` have NULL
 * `workspace_id`; this script gives each user a default workspace and
 * backfills the foreign-key column so the app can treat workspace_id as
 * non-null for user-scoped queries.
 *
 * Mapping rules:
 *   - One default workspace per user (name "默认工作区"; i18n is a UI
 *     concern, the DB stores a stable default).
 *   - sessions.workspace_id ← the session owner's default workspace.
 *   - agent_tasks.workspace_id ← the task owner's default workspace
 *     (falls back to the session owner if `agent_tasks.user_id` is NULL).
 *   - long_term_memories.workspace_id stays NULL for both `__global__`
 *     and `proj-xxx` rows. `__global__` is the intended "global layer"
 *     (visible to all workspaces via the additive `OR workspace_id IS
 *     NULL` arm of recall); `proj-xxx` rows are path-B artifacts that no
 *     user workspace owns, so NULL keeps them globally visible without
 *     inventing a fake owner.
 *   - builtin_memories: global template rows (workspace_id IS NULL) are
 *     left in place. New workspaces clone them at creation time in the
 *     app layer (M2.4); this migration does NOT clone for the default
 *     workspaces because the global rows already serve every workspace
 *     that has no workspace-specific override.
 *
 * Idempotent: uses `WHERE workspace_id IS NULL` guards, so re-running on
 * every boot is a cheap no-op once all rows are backfilled. Safe to run
 * on every boot.
 *
 * Run by `self-host-migrate.ts` / `vercel-postbuild.ts` after
 * `drizzle-kit push` (the tables and columns must exist first).
 */
import { dedupGlobalLongTermMemories } from './dedup-global-memories';
import { closeRawSql, getRawQuery } from './db-raw-sql';

type BackfillCount = {
  users: number;
  workspaces_created: number;
  sessions_backfilled: number;
  tasks_backfilled: number;
};

async function backfillWorkspaces(): Promise<BackfillCount> {
  const query = getRawQuery();

  // 1. Create a default workspace for every user that doesn't have one yet.
  //    Atomic per-owner default: the partial unique index
  //    workspaces_owner_default_uniq (owner_id WHERE is_default) is the
  //    conflict target, so concurrent runs (or a race with
  //    getOrCreateDefaultWorkspace) can no longer each insert a default —
  //    the second hits the constraint and does nothing. CTE candidate
  //    selection filters to users with no default row at all.
  // NB: users.id is uuid while workspaces.owner_id is text (the repo's
  // user_id columns are all text; the app always passes ids as bound
  // string params so the mismatch never surfaces there). Column-to-column
  // comparisons/assignments in raw SQL need explicit casts — Postgres has
  // no `text = uuid` operator (error: op_error, "No operator matches").
  const created = await query<{ id: string; owner_id: string }>(`
    WITH candidates AS (
      SELECT u.id AS user_id
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.owner_id = u.id::text AND w.is_default = true
      )
    )
    INSERT INTO workspaces (owner_id, name, status, is_default)
    SELECT user_id::text, '默认工作区', 'active', true FROM candidates
    ON CONFLICT (owner_id) WHERE is_default = true DO NOTHING
    RETURNING id, owner_id
  `);

  // 2. Backfill sessions.workspace_id from the session owner's default
  //    workspace. Sessions with no owner (NULL user_id) stay NULL — they
  //    predate per-user isolation and have no natural workspace.
  const sessionsResult = await query<{ count: number }>(`
    WITH owner_ws AS (
      SELECT DISTINCT ON (owner_id) id AS workspace_id, owner_id
      FROM workspaces
      ORDER BY owner_id, is_default DESC, created_at ASC
    )
    UPDATE sessions s
    SET workspace_id = ow.workspace_id
    FROM owner_ws ow
    WHERE s.user_id = ow.owner_id
      AND s.workspace_id IS NULL
      AND s.user_id IS NOT NULL
    RETURNING 1
  `);
  const sessionsBackfilled = sessionsResult.length;

  // 3. Backfill agent_tasks.workspace_id. Prefer the task's own user_id;
  //    fall back to the session owner when the task row has no user_id
  //    (path-B tasks historically leave it NULL). Tasks with neither stay NULL.
  const tasksResult = await query<{ count: number }>(`
    WITH owner_ws AS (
      SELECT DISTINCT ON (owner_id) id AS workspace_id, owner_id
      FROM workspaces
      ORDER BY owner_id, is_default DESC, created_at ASC
    )
    UPDATE agent_tasks t
    SET workspace_id = COALESCE(
      (SELECT workspace_id FROM owner_ws ow WHERE ow.owner_id = t.user_id),
      (SELECT workspace_id FROM owner_ws ow
         JOIN sessions s ON s.id = t.session_id
         WHERE ow.owner_id = s.user_id)
    )
    WHERE t.workspace_id IS NULL
      AND (
        t.user_id IS NOT NULL
        OR (t.session_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id AND s.user_id IS NOT NULL))
      )
    RETURNING 1
  `);
  const tasksBackfilled = tasksResult.length;

  // 4. Total users that now have at least one workspace (for logging).
  const usersResult = await query<{ count: number }>(`
    SELECT COUNT(DISTINCT owner_id)::int AS count FROM workspaces
  `);

  return {
    users: usersResult[0]?.count ?? 0,
    workspaces_created: created.length,
    sessions_backfilled: sessionsBackfilled,
    tasks_backfilled: tasksBackfilled,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('[migrate-workspaces] DATABASE_URL is required');
  }

  // Defense in depth: the pre-push dedup in vercel-postbuild.ts /
  // self-host-migrate.ts runs first, but this script can also be run
  // standalone — clean duplicate global rows before backfilling so a
  // later partial-unique-index creation cannot fail on legacy dupes.
  // No-ops when the table/column doesn't exist or no dupes remain.
  const duplicatesRemoved = await dedupGlobalLongTermMemories();
  if (duplicatesRemoved > 0) {
    console.log(
      `[migrate-workspaces] removed ${duplicatesRemoved} duplicate global long_term_memories row(s) before backfill`,
    );
  }

  const result = await backfillWorkspaces();

  // Only log when something actually happened — keeps boot output quiet on
  // steady-state restarts (matches the vault/message-versions style).
  if (
    result.workspaces_created > 0 ||
    result.sessions_backfilled > 0 ||
    result.tasks_backfilled > 0
  ) {
    console.log(
      `[migrate-workspaces] created ${result.workspaces_created} default workspace(s) for ${result.users} user(s); ` +
        `backfilled ${result.sessions_backfilled} session(s) and ${result.tasks_backfilled} task(s)`,
    );
  } else {
    console.log('[migrate-workspaces] no backfill needed');
  }
}

main()
  .catch((error) => {
    console.error('[migrate-workspaces] failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await closeRawSql();
  });
