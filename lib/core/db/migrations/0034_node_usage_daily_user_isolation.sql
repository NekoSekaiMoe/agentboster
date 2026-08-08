-- #11 nodeUsageDaily multi-user isolation.
--
-- Background: the original unique index on node_usage_daily was
-- (node_id, date, provider, model) with NO user_id. Multiple users
-- sharing a node on the same day/provider/model collided into a single
-- rolled-up row (later writes added onto the first user's bucket), and
-- getUserUsageSum(WHERE user_id = ?) silently lost or mis-attributed
-- usage. This migration:
--
--   1. Backfills any NULL user_id to the '__shared__' sentinel so that
--      every row carries a concrete conflict-key value. NULL must not
--      remain in a column that is part of the new unique index because
--      Postgres treats NULL != NULL and the constraint would not fire,
--      letting duplicates multiply again.
--   2. Drops the old 4-column unique index and recreates it with
--      user_id inserted as the second key. Different users on the same
--      node/day/provider/model now roll up independently; same-user
--      upserts still hit the conflict target and add atomically.
--
-- Idempotent: the backfill is a no-op once no NULLs remain, and the
-- index operations use IF NOT EXISTS / IF EXISTS guards.
UPDATE "node_usage_daily"
   SET "user_id" = '__shared__'
 WHERE "user_id" IS NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "node_usage_daily_node_date_provider_model_idx";--> statement-breakpoint

-- The task_usage.user_id column is also backfilled for consistency so
-- historical rows join cleanly against per-user queries; it is NOT part
-- of task_usage's unique key, so no index change is needed there.
UPDATE "task_usage"
   SET "user_id" = '__shared__'
 WHERE "user_id" IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "node_usage_daily_node_date_provider_model_idx"
  ON "node_usage_daily" USING btree ("node_id","user_id","date","provider","model");
