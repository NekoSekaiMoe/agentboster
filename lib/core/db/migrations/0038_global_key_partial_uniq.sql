-- 0038_global_key_partial_uniq
--
-- long_term_memories uniqueness fix (review.md #5/#9): the 0037 composite
-- unique index (user_id, project_id, memory_key, workspace_id) did NOT use
-- NULLS NOT DISTINCT, so PostgreSQL treated NULL workspace_id as distinct
-- and global rows (workspace_id IS NULL) could duplicate per
-- (user, project, key). Applying NULLS NOT DISTINCT to the whole composite
-- was rejected because it would also collapse rows whose memory_key is NULL
-- (keyless/manual writes rely on NULL keys staying distinct).
--
-- Fix: split into two partial unique indexes —
--   1. global rows: unique (user_id, project_id, memory_key)
--      WHERE workspace_id IS NULL
--   2. workspace rows: unique (user_id, project_id, memory_key, workspace_id)
--      WHERE workspace_id IS NOT NULL
--
-- Existing deployments may already carry duplicate global rows, so dedupe
-- them FIRST (keeping the most recently updated row per group; plain `=`
-- comparisons match the index's NULL semantics — groups with NULL
-- user_id/project_id are still distinct under the index and need no merge).
-- Guards make re-runs safe on databases that may have applied an equivalent
-- via `drizzle-kit push --force`.

DELETE FROM "long_term_memories" a
USING "long_term_memories" b
WHERE a."workspace_id" IS NULL
  AND b."workspace_id" IS NULL
  AND a."user_id" = b."user_id"
  AND a."project_id" = b."project_id"
  AND a."memory_key" = b."memory_key"
  AND (a."updated_at" < b."updated_at"
       OR (a."updated_at" = b."updated_at" AND a."id" < b."id"));--> statement-breakpoint
DROP INDEX IF EXISTS "long_term_memories_user_project_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "long_term_memories_user_project_key_global_uniq" ON "long_term_memories" USING btree ("user_id","project_id","memory_key") WHERE workspace_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "long_term_memories_user_project_key_idx" ON "long_term_memories" USING btree ("user_id","project_id","memory_key","workspace_id") WHERE workspace_id IS NOT NULL;
