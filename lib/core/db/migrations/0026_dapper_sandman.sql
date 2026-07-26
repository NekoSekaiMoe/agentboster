DROP INDEX "long_term_memories_user_key_idx";--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_memories_user_project_key_idx" ON "long_term_memories" USING btree ("user_id","project_id","memory_key");--> statement-breakpoint
CREATE INDEX "long_term_memories_user_project_updated_idx" ON "long_term_memories" USING btree ("user_id","project_id","updated_at");