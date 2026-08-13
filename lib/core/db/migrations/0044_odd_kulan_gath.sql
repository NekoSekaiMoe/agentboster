ALTER TABLE "agent_tasks" ADD COLUMN "owner_node_id" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_tasks_lease_expires_at_idx" ON "agent_tasks" USING btree ("lease_expires_at") WHERE status IN ('pending', 'reviewing', 'running');