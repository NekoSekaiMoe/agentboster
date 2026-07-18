-- Adding IF NOT EXISTS guards because `notify_channel` and
-- `remote_control` were previously added to the schema definition
-- without a generated migration, so existing production DBs may
-- already have these columns. New deployments that ran 0000 only
-- will get them here; existing deployments skip harmlessly.
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "notify_channel" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "remote_control" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "preferred_node_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "allowed_nodes" text[];--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "auto_fallback_node" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "disabled_by_failure" boolean DEFAULT false NOT NULL;
