-- Add project scoping to long_term_memories.
--
-- NOTE on CONCURRENTLY: these index DDLs run inside Drizzle's migrate()
-- transaction (each statement-breakpoint stays in the same txn). PostgreSQL
-- forbids CREATE/DROP INDEX CONCURRENTLY inside a transaction block, so do
-- NOT retrofit these statements with CONCURRENTLY without first splitting
-- them into a standalone, non-transactional custom migration. Evaluate
-- the long_term_memories row count and the production maintenance window
-- before doing so — until then, the transactional DROP + CREATE here is
-- correct and safe for the sizes this table currently sees.
--
-- Ordering matters (review-driven): the backfill runs BEFORE the new unique
-- index is created. If we created the unique index first, a still-running
-- older app instance could insert duplicate (user_id, NULL, memory_key) rows
-- in the window between "new index live" and "backfill runs" — then the
-- backfill would flip both to '__global__' and collide on the new unique
-- constraint, failing the migration. By backfilling while only the OLD
-- (user_id, memory_key) index is gone and no replacement exists yet, the
-- UPDATE touches every legacy row without any constraint to violate.
ALTER TABLE "long_term_memories" ADD COLUMN "project_id" text;--> statement-breakpoint
DROP INDEX "long_term_memories_user_key_idx";--> statement-breakpoint
UPDATE "long_term_memories"
SET "project_id" = '__global__'
WHERE "project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_memories_user_project_key_idx" ON "long_term_memories" USING btree ("user_id","project_id","memory_key");--> statement-breakpoint
CREATE INDEX "long_term_memories_user_project_updated_idx" ON "long_term_memories" USING btree ("user_id","project_id","updated_at");
