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

UPDATE "long_term_memories"
SET "project_id" = '__global__'
WHERE "project_id" IS NULL;
