CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text,
	"sandbox_id" text NOT NULL,
	"sandbox_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "task_summaries" ADD COLUMN "workspace_id" uuid;