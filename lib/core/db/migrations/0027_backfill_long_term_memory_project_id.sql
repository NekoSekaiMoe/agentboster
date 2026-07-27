-- Backfill safety-net for long_term_memories.project_id.
--
-- 0026_dapper_sandman already backfills '__global__' as part of the same
-- migration (the backfill runs there before the new unique index is
-- created, to avoid a constraint-violation window). This statement is a
-- deliberately-kept idempotent safety net: it catches any row that still
-- has project_id IS NULL after 0026 — e.g. rows written by an older app
-- instance during the deploy window, or anything a partial-restore left
-- behind. Safe to run with concurrent writes: app code only ever inserts
-- the sentinel or a real project id (never NULL), so the UPDATE only
-- touches legacy rows.
--
-- Step 1: Remove duplicate (user_id, memory_key) rows that would collide
-- on the unique index once project_id is set to '__global__'. Keep the
-- most-recently-updated row in each group; ties broken by id (highest
-- wins). Also remove rows that would collide with an *existing*
-- '__global__' row (i.e. a row already backfilled by 0026).
DELETE FROM "long_term_memories"
WHERE "project_id" IS NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id", "memory_key") "id"
    FROM "long_term_memories"
    WHERE "project_id" IS NULL
      -- Exclude groups where a '__global__' row already exists; those NULL
      -- rows are pure duplicates and should all be removed.
      AND NOT EXISTS (
        SELECT 1 FROM "long_term_memories" AS existing
        WHERE existing."user_id" = "long_term_memories"."user_id"
          AND existing."memory_key" = "long_term_memories"."memory_key"
          AND existing."project_id" = '__global__'
      )
    ORDER BY "user_id", "memory_key", "updated_at" DESC NULLS LAST, "id" DESC
  );--> statement-breakpoint

-- Step 2: Backfill remaining NULL rows (now guaranteed unique per
-- (user_id, memory_key) within the NULL set, with no __global__ conflict).
UPDATE "long_term_memories"
SET "project_id" = '__global__'
WHERE "project_id" IS NULL;
