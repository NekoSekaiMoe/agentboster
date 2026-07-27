-- Backfill safety-net for long_term_memories.project_id.
--
-- 0026_dapper_sandman already backfills '__global__' as part of the same
-- migration (the backfill runs there before the new unique index is
-- created, to avoid a constraint-violation window). This statement is a
-- deliberately-kept idempotent safety net: it catches any row that still
-- has project_id IS NULL after 0026 — e.g. rows written by an older app
-- instance during the deploy window, or anything a partial-restore left
-- behind.
--
-- Strategy: for each (user_id, memory_key) group that has NULL or
-- '__global__' rows, pick ONE winner (most recent updated_at, then
-- highest id), delete all other duplicates in that group, and finally
-- set the winner's project_id to '__global__' if it was NULL. This
-- avoids unique-index violations regardless of which combination of
-- NULL / '__global__' duplicates exist.

-- Step 1: Delete all duplicate rows in groups that would collide.
-- A "collision group" is any (user_id, memory_key) where project_id is
-- either NULL or '__global__'. Within each group, keep only the single
-- best row (by updated_at DESC NULLS LAST, id DESC).
DELETE FROM "long_term_memories"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "user_id", "memory_key"
             ORDER BY "updated_at" DESC NULLS LAST, "id" DESC
           ) AS rn
    FROM "long_term_memories"
    WHERE "project_id" IS NULL OR "project_id" = '__global__'
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- Step 2: Backfill remaining NULL rows. After step 1, each
-- (user_id, memory_key) has at most one row with project_id IN (NULL,
-- '__global__'), so flipping NULL → '__global__' cannot violate the
-- unique index.
UPDATE "long_term_memories"
SET "project_id" = '__global__'
WHERE "project_id" IS NULL;
