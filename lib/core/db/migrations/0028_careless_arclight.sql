CREATE TABLE "dream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"phases" text NOT NULL,
	"operations" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "long_term_memories" ALTER COLUMN "project_id" SET DEFAULT '__global__';--> statement-breakpoint
ALTER TABLE "long_term_memories" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "dream_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "dream_meta" jsonb;--> statement-breakpoint
CREATE INDEX "dream_runs_user_started_idx" ON "dream_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "long_term_memories_dream_status_active_idx" ON "long_term_memories" USING btree ("user_id","dream_status") WHERE dream_status = 'active';