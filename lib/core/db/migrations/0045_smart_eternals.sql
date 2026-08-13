ALTER TABLE "sessions" ADD COLUMN "goal_text" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "goal_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "hidden_continuation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "consecutive_non_progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_eval_reason" text;