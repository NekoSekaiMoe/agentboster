-- 0037_workspace_memory_boundary
--
-- Memory workspace boundary fixes (from review.md verification + follow-up
-- tech-debt work). Applied on top of the M0a-M4 workspace split that had been
-- pushed via `drizzle-kit push` without a recorded migration.
--
-- 1) builtin_memories: the nullable workspace_id was part of a composite
--    PRIMARY KEY (workspace_id, key), but PostgreSQL forces all PK columns
--    NOT NULL, so global template rows (workspace_id IS NULL) could never be
--    persisted. Replace the composite PK with a synthetic UUID id and two
--    unique indexes: a partial unique index on (key) WHERE workspace_id IS
--    NULL for global templates, and a (workspace_id, key) unique index for
--    workspace-scoped rows.
--
-- 2) long_term_memories: the unique index (user_id, project_id, memory_key)
--    did not include workspace_id, so the same logical key could collide
--    across workspaces. Rebuild it to include workspace_id, and add a
--    workspace_id lookup index for workspace-scoped recall.
--
-- 3) workspaces: add is_default (the owner's designated default workspace)
--    plus a partial unique index (owner_id) WHERE is_default = true, closing
--    the getOrCreateDefaultWorkspace TOCTOU race.
--
-- Guards make re-runs safe on databases that may already have applied some
-- of these via `drizzle-kit push --force`.
--
-- Replay-chain note (review.md follow-up): the M0a split itself (legacy
-- `workspaces` → `project_sandboxes`, new user-facing `workspaces`,
-- workspace_id columns) was never recorded before this file, so a DB that
-- replays ONLY the SQL chain (drizzle-kit migrate) reaches this migration
-- without those columns. The ADD COLUMN IF NOT EXISTS statements below make
-- this file self-sufficient for the columns it touches, and the workspaces
-- statements are conditional on the NEW user-facing shape (owner_id) — on a
-- replay-only DB `workspaces` is still the legacy project-sandbox table at
-- this point; 0039_m0a_workspace_split_replay performs the rename/recreation
-- and the backfill.
--
-- Online-index note (review.md nitpick): the index DROP/CREATEs here and in
-- 0038 deliberately stay plain (not CONCURRENTLY). The supported deployment
-- entries (scripts/self-host-migrate.ts, scripts/vercel-postbuild.ts) apply
-- schema via `drizzle-kit push`, which executes statements directly without
-- wrapping this file in a transaction; drizzle-kit migrate DOES wrap each
-- file in a transaction, where CREATE INDEX CONCURRENTLY is illegal anyway.
-- Target tables are small in both deployment modes (single-user self-host /
-- low-volume SaaS), so blocking builds are sub-second. If a future
-- deployment grows long_term_memories enough for this to matter, run the
-- CONCURRENTLY equivalents manually in a maintenance window instead of
-- replaying this file.

-- workspace_id columns first: on a replay-only DB these don't exist yet and
-- every statement below that references them would fail.
ALTER TABLE "long_term_memories" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "builtin_memories" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
DROP INDEX IF EXISTS "long_term_memories_user_project_key_idx";--> statement-breakpoint
ALTER TABLE "builtin_memories" DROP CONSTRAINT IF EXISTS "builtin_memories_workspace_id_key_pk";--> statement-breakpoint
ALTER TABLE "builtin_memories" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
-- Promote id to PRIMARY KEY only if the table has none yet (guarded so a
-- re-run after push doesn't fail on "multiple primary keys"). On a
-- replay-only DB the recorded chain left the PK on "key" (see 0000);
-- 0039_m0a_workspace_split_replay handles that promotion.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.builtin_memories'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "builtin_memories" ADD PRIMARY KEY ("id");
  END IF;
END $$;--> statement-breakpoint
-- workspaces: only when the table already has the NEW user-facing shape
-- (owner_id). On a replay-only DB `workspaces` is still the legacy
-- project-sandbox table here; 0039 renames/recreates it with is_default.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'owner_id'
  ) THEN
    ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_owner_default_uniq" ON "workspaces" USING btree ("owner_id") WHERE is_default = true';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builtin_memories_global_key_idx" ON "builtin_memories" USING btree ("key") WHERE workspace_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builtin_memories_workspace_key_idx" ON "builtin_memories" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "long_term_memories_workspace_idx" ON "long_term_memories" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "long_term_memories_user_project_key_idx" ON "long_term_memories" USING btree ("user_id","project_id","memory_key","workspace_id");
