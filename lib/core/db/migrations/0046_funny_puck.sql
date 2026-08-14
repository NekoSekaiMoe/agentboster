-- Rebuild agent_tasks_lease_expires_at_idx to lead with owner_node_id.
-- Rationale (code review C10): renewTaskLeases(nodeId) is the hot path
-- (every heartbeat filters by owner_node_id); reapOrphanedTasks() is the
-- cold path and still benefits from the partial predicate + a range scan
-- on lease_expires_at under owner_node_id.
--
-- NOTE on CONCURRENTLY (code review C11): this migration deliberately uses
-- plain (blocking) CREATE/DROP INDEX rather than CREATE INDEX CONCURRENTLY.
-- This historical migration deliberately records the blocking rebuild used
-- at the time. Supported deployments apply the schema with `drizzle-kit push`
-- rather than replaying this file. Current Drizzle versions execute Postgres
-- push statements individually and support `.concurrently()` in the schema;
-- future indexes on populated hot tables should use that option instead.
DROP INDEX "agent_tasks_lease_expires_at_idx";--> statement-breakpoint
CREATE INDEX "agent_tasks_lease_expires_at_idx" ON "agent_tasks" USING btree ("owner_node_id","lease_expires_at") WHERE status IN ('pending', 'reviewing', 'running');
