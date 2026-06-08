ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "source" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_review_logs" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_review_logs" ADD COLUMN IF NOT EXISTS "roles" text[];
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"nonce" text NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_entries_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_entries_key_idx" ON "vault_entries" ("key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
