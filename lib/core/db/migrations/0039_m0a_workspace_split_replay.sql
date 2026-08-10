-- 0039_m0a_workspace_split_replay
--
-- Replayable M0a/M1/M2 workspace split (review.md follow-up). The split —
-- legacy `workspaces` (project ↔ sandbox bindings) renamed to
-- `project_sandboxes`, a NEW user-facing `workspaces` table, and
-- workspace_id columns on sessions / agent_tasks / long_term_memories /
-- builtin_memories — was applied to real deployments via `drizzle-kit push`
-- without a recorded migration. A deployment that replays ONLY the SQL
-- chain (drizzle-kit migrate) could therefore never reach the structure
-- described by the 0037/0038 snapshots. This migration closes the gap.
--
-- Every statement is guarded and idempotent:
--   - on any real deployment (already at the 0038 structure) everything
--     below is a no-op;
--   - on a replay-only DB it performs the rename, creates the new table,
--     and runs the default-workspace backfill, reaching the same structure.
--
-- The backfill mirrors scripts/migrate-workspaces.ts (which the supported
-- entries — self-host-migrate.ts / vercel-postbuild.ts — run after push);
-- embedding it here makes the SQL chain self-sufficient for migrate-only
-- deployments. Same idempotency guards (`WHERE workspace_id IS NULL`,
-- `NOT EXISTS`), so re-runs are cheap no-ops.

-- 1) workspace_id columns not covered by 0037 (which adds the
--    long_term_memories / builtin_memories ones).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint

-- 2) Legacy `workspaces` → `project_sandboxes`, but only when the DB still
--    has the LEGACY shape (project_id column) and no project_sandboxes yet.
--    0037 (pre-fix versions) may have added is_default to the legacy table
--    on such DBs — drop that stray before the rename. The unique constraint
--    keeps its original name through a RENAME TABLE, so rename it to match
--    the recorded snapshot (project_sandboxes_project_id_unique).
DO $$ BEGIN
  IF to_regclass('public.project_sandboxes') IS NULL
     AND to_regclass('public.workspaces') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'project_id'
     )
  THEN
    ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "is_default";
    ALTER TABLE "workspaces" RENAME TO "project_sandboxes";
    ALTER TABLE "project_sandboxes" RENAME CONSTRAINT "workspaces_project_id_unique" TO "project_sandboxes_project_id_unique";
  END IF;
END $$;--> statement-breakpoint

-- 3) New user-facing workspaces table. CREATE TABLE IF NOT EXISTS is a
--    no-op on real deployments (the table already exists with this shape).
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"preferred_node_id" text,
	"node_generation" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_owner_idx" ON "workspaces" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_owner_default_uniq" ON "workspaces" USING btree ("owner_id") WHERE is_default = true;--> statement-breakpoint

-- 4) builtin_memories: on a replay-only DB the recorded chain left the PK
--    on "key" (0000), and 0037's id-promotion skipped because a PK exists.
--    Promote id to PK whenever it isn't already (no-op on real
--    deployments, where 0037/push already made id the PK).
DO $$ BEGIN
  IF to_regclass('public.builtin_memories') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.builtin_memories'::regclass
      AND c.contype = 'p'
      AND a.attname = 'id'
  ) THEN
    ALTER TABLE "builtin_memories" DROP CONSTRAINT IF EXISTS "builtin_memories_pkey";
    ALTER TABLE "builtin_memories" ADD PRIMARY KEY ("id");
  END IF;
END $$;--> statement-breakpoint

-- 5) Backfill: one default workspace per user that has none. Atomic per
--    owner via the workspaces_owner_default_uniq partial unique index.
INSERT INTO "workspaces" ("owner_id", "name", "status", "is_default")
SELECT u.id, '默认工作区', 'active', true
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "workspaces" w
  WHERE w."owner_id" = u.id AND w."is_default" = true
)
ON CONFLICT ("owner_id") WHERE is_default = true DO NOTHING;--> statement-breakpoint

-- 6) sessions.workspace_id ← session owner's default workspace. Sessions
--    with no owner (NULL user_id) stay NULL.
WITH owner_ws AS (
  SELECT DISTINCT ON ("owner_id") "id" AS workspace_id, "owner_id"
  FROM "workspaces"
  ORDER BY "owner_id", "is_default" DESC, "created_at" ASC
)
UPDATE "sessions" s
SET "workspace_id" = ow.workspace_id
FROM owner_ws ow
WHERE s."user_id" = ow."owner_id"
  AND s."workspace_id" IS NULL
  AND s."user_id" IS NOT NULL;--> statement-breakpoint

-- 7) agent_tasks.workspace_id ← task owner's default workspace, falling
--    back to the session owner when agent_tasks.user_id is NULL. Tasks
--    with neither stay NULL.
WITH owner_ws AS (
  SELECT DISTINCT ON ("owner_id") "id" AS workspace_id, "owner_id"
  FROM "workspaces"
  ORDER BY "owner_id", "is_default" DESC, "created_at" ASC
)
UPDATE "agent_tasks" t
SET "workspace_id" = COALESCE(
  (SELECT workspace_id FROM owner_ws ow WHERE ow."owner_id" = t."user_id"),
  (SELECT workspace_id FROM owner_ws ow
     JOIN "sessions" s ON s."id" = t."session_id"
     WHERE ow."owner_id" = s."user_id")
)
WHERE t."workspace_id" IS NULL
  AND (
    t."user_id" IS NOT NULL
    OR (t."session_id" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "sessions" s WHERE s."id" = t."session_id" AND s."user_id" IS NOT NULL))
  );
