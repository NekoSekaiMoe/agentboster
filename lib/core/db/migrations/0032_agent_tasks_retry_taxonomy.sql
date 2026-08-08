-- Add failure taxonomy + retry lineage columns to agent_tasks.
-- See lib/core/task/failure-reason.ts for the 22 canonical FailureReason values
-- (8 platform-side + 14 agent_error.*) and Classify() ported from Multica.
-- attempt is 1-based (1 = original, 2 = first retry); max_attempts default 2
-- (one auto-retry). retry_of_task_id is system retry lineage; rerun_of_task_id
-- is user-driven rerun lineage (distinct concepts from Multica migration 184).
ALTER TABLE "agent_tasks" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "max_attempts" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "retry_of_task_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "rerun_of_task_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_tasks_failure_reason_idx" ON "agent_tasks" USING btree ("failure_reason");--> statement-breakpoint
CREATE INDEX "agent_tasks_retry_of_task_id_idx" ON "agent_tasks" USING btree ("retry_of_task_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_rerun_of_task_id_idx" ON "agent_tasks" USING btree ("rerun_of_task_id");
