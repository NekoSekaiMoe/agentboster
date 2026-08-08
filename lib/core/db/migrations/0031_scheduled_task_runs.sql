CREATE TABLE "scheduled_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"source" text DEFAULT 'schedule' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"planned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"run_id" text,
	"failure_reason" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_task_planned_idx" ON "scheduled_task_runs" USING btree ("task_id","planned_at");--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_task_status_idx" ON "scheduled_task_runs" USING btree ("task_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_task_runs_task_planned_uniq" ON "scheduled_task_runs" USING btree ("task_id","planned_at") WHERE "scheduled_task_runs"."planned_at" IS NOT NULL;