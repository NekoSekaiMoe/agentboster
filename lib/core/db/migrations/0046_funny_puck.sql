-- Rebuild agent_tasks_lease_expires_at_idx to lead with owner_node_id.
-- Rationale (code review C10): renewTaskLeases(nodeId) is the hot path
-- (every heartbeat filters by owner_node_id); reapOrphanedTasks() is the
-- cold path and still benefits from the partial predicate + a range scan
-- on lease_expires_at under owner_node_id.
--
-- NOTE on CONCURRENTLY (code review C11): this migration deliberately uses
-- plain (blocking) CREATE/DROP INDEX rather than CREATE INDEX CONCURRENTLY.
-- Both deployment paths in this repo (Vercel postbuild and self-host
-- docker-entrypoint) apply schema changes via `drizzle-kit push`, which
-- generates and runs its own DDL in a transaction and does not support
-- CONCURRENTLY. This recorded migration file is not executed by either
-- path (it exists for diff/audit only), so adding CONCURRENTLY here would
-- be inert. If a future populated-production deployment ever needs to
-- rebuild this index without blocking writes, run the DROP/CREATE
-- CONCURRENTLY by hand against the live DB.
DROP INDEX "agent_tasks_lease_expires_at_idx";--> statement-breakpoint
CREATE INDEX "agent_tasks_lease_expires_at_idx" ON "agent_tasks" USING btree ("owner_node_id","lease_expires_at") WHERE status IN ('pending', 'reviewing', 'running');
