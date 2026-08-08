-- Add session_id -> sessions.id FK with ON DELETE CASCADE.
--
-- This is a hand-written replacement for the drizzle-kit-generated version of
-- this migration. drizzle-kit's `references()` API cannot express
-- `NOT VALID` (the schema DSL has no field for it), so a plain `generate`
-- would emit a plain `ADD CONSTRAINT` that scans and briefly blocks writes on
-- the table while it validates all existing rows.
--
-- Instead we add the constraint WITH NOT VALID here (skips the initial
-- all-rows check, only applies to future writes) and VALIDATE it separately
-- in 0025_validate_orchestration_plans_fk.sql. This is the standard Postgres
-- pattern for adding a FK to a table that may already have rows.
--
-- (Historical note: the original meta/0024_snapshot.json has since been
-- pruned along with all pre-0034 snapshots; this migration's effect is already
-- reflected in the live schema and the surviving 0034_snapshot.json.)
ALTER TABLE "agent_orchestration_plans"
  ADD CONSTRAINT "agent_orchestration_plans_session_id_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id")
  ON DELETE cascade ON UPDATE no action NOT VALID;
