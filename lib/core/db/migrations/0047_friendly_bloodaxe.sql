ALTER TABLE "agent_review_logs" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "agent_tool_activity_logs" ADD COLUMN "trace_id" text;--> statement-breakpoint
CREATE INDEX "agent_review_logs_trace_created_idx" ON "agent_review_logs" USING btree ("trace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tool_activity_logs_trace_created_idx" ON "agent_tool_activity_logs" USING btree ("trace_id","created_at");