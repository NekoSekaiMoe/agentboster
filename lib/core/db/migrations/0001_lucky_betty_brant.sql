CREATE TABLE "task_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"progress" text,
	"decisions" jsonb,
	"pending" jsonb,
	"known_issues" jsonb,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_summaries_task_id_unique" UNIQUE("task_id")
);
