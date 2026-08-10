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

DROP INDEX IF EXISTS "long_term_memories_user_project_key_idx";--> statement-breakpoint
ALTER TABLE "builtin_memories" DROP CONSTRAINT IF EXISTS "builtin_memories_workspace_id_key_pk";--> statement-breakpoint
ALTER TABLE "builtin_memories" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
-- Promote id to PRIMARY KEY only if the table has none yet (guarded so a
-- re-run after push doesn't fail on "multiple primary keys").
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.builtin_memories'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "builtin_memories" ADD PRIMARY KEY ("id");
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builtin_memories_global_key_idx" ON "builtin_memories" USING btree ("key") WHERE workspace_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builtin_memories_workspace_key_idx" ON "builtin_memories" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "long_term_memories_workspace_idx" ON "long_term_memories" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_owner_default_uniq" ON "workspaces" USING btree ("owner_id") WHERE is_default = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "long_term_memories_user_project_key_idx" ON "long_term_memories" USING btree ("user_id","project_id","memory_key","workspace_id");
