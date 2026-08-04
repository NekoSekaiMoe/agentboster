ALTER TABLE "long_term_memories" ADD COLUMN "source_kind" text DEFAULT 'assistant_observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "trigger_phrases" text[];--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "recall_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "recall_query_hashes" jsonb;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "last_recalled_at" timestamp with time zone;