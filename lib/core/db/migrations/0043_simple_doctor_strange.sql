ALTER TABLE "long_term_memories" ADD COLUMN "quarantine_meta" jsonb;--> statement-breakpoint
ALTER TABLE "session_memories" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "quarantine_epoch" integer DEFAULT 0 NOT NULL;