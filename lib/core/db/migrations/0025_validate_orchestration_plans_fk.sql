-- Validate the session_id FK added in 0024.
--
-- 0024 added the constraint WITH NOT VALID to avoid a full-table-scan write
-- block while existing rows were checked. Now that the constraint exists
-- (and the table is small / idle-safe here), VALIDATE CONSTRAINT back-fills
-- the validation: it scans existing rows in a non-blocking fashion (takes a
-- ShareUpdateExclusiveLock, not an AccessExclusiveLock) and, once it succeeds,
-- the constraint is fully valid for all future inserts and the planner can
-- rely on it.
--
-- Splitting add (NOT VALID) + validate into two steps is the standard
-- Postgres pattern for adding FK/CHECK constraints to a table that may have
-- data or concurrent writes. See review.md finding on 0024.
ALTER TABLE "agent_orchestration_plans"
  VALIDATE CONSTRAINT "agent_orchestration_plans_session_id_sessions_id_fk";
