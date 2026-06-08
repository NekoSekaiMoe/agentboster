CREATE TABLE IF NOT EXISTS "agent_tool_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"session_id" uuid,
	"agent_id" text NOT NULL,
	"user_id" text,
	"roles" text[],
	"source" jsonb,
	"sandbox_id" text,
	"model" text,
	"step" integer,
	"tool_call_id" text,
	"tool_name" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"arguments" jsonb,
	"result" jsonb,
	"output_text" text,
	"success" boolean DEFAULT false NOT NULL,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_activity_logs_task_idx" ON "agent_tool_activity_logs" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_activity_logs_session_idx" ON "agent_tool_activity_logs" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_activity_logs_agent_created_idx" ON "agent_tool_activity_logs" ("agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_activity_logs_tool_created_idx" ON "agent_tool_activity_logs" ("tool_name", "created_at");
