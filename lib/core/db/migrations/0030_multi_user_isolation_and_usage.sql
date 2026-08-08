CREATE TABLE "node_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text NOT NULL,
	"user_id" text,
	"date" date NOT NULL,
	"provider" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd_ticks" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text,
	"provider" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd_ticks" bigint,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "max_attempts" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "retry_of_task_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "rerun_of_task_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "node_usage_daily_node_date_provider_model_idx" ON "node_usage_daily" USING btree ("node_id","date","provider","model");--> statement-breakpoint
CREATE INDEX "node_usage_daily_node_date_idx" ON "node_usage_daily" USING btree ("node_id","date");--> statement-breakpoint
CREATE INDEX "node_usage_daily_user_id_idx" ON "node_usage_daily" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_usage_task_provider_model_idx" ON "task_usage" USING btree ("task_id","provider","model");--> statement-breakpoint
CREATE INDEX "task_usage_task_id_idx" ON "task_usage" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_usage_user_id_idx" ON "task_usage" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_vault_entries_user_id_key_idx" ON "user_vault_entries" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "agent_tasks_failure_reason_idx" ON "agent_tasks" USING btree ("failure_reason");--> statement-breakpoint
CREATE INDEX "agent_tasks_retry_of_task_id_idx" ON "agent_tasks" USING btree ("retry_of_task_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_rerun_of_task_id_idx" ON "agent_tasks" USING btree ("rerun_of_task_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");