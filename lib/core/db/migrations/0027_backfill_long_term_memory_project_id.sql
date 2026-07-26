-- Backfill long_term_memories.project_id for pre-existing rows.
--
-- 0026_dapper_sandman (drizzle-kit generated) added the project_id column and
-- moved the unique constraint from (user_id, memory_key) to
-- (user_id, project_id, memory_key). App code (lib/memory/scope.ts) writes a
-- GLOBAL sentinel ('__global__') instead of NULL so the unique constraint is
-- meaningful for global memories.
--
-- But drizzle's generator can't express that semantic backfill, so existing
-- rows (all of which predate project scoping and are therefore global by
-- definition) still have project_id IS NULL. That makes project-scoped recall
-- and the project-aggregate view miss every historical memory.
--
-- This migration normalizes the column in place. It is idempotent and safe
-- to run with concurrent writes: app code only ever inserts the sentinel or a
-- real project id (never NULL), so the UPDATE only touches legacy rows.

UPDATE "long_term_memories"
SET "project_id" = '__global__'
WHERE "project_id" IS NULL;
