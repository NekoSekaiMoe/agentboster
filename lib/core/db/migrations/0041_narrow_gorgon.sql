ALTER TABLE "long_term_memories" ALTER COLUMN "shared" SET DEFAULT false;--> statement-breakpoint
-- Backfill for the new multi-member semantics: legacy rows were written
-- under the old DEFAULT true (single-user MVP). Flip them to personal so
-- (a) recall's (shared OR user_id = requester) rule keeps them visible to
-- exactly their creator, and (b) deleting a workspace's shared pool
-- (shared=true) never touches pre-existing personal memories. 'system'
-- rows stay shared — they are global facts owned by no single user.
-- NULL user_id rows are flipped to personal too: `NULL <> 'system'`
-- evaluates to NULL, so a bare `<>` would silently skip them and leave
-- them visible to every workspace member. After the flip they match
-- neither `shared = true` nor `user_id = requester`, i.e. they become
-- visible to NOBODY — the fail-closed direction for rows whose
-- ownership cannot be established.
UPDATE "long_term_memories" SET "shared" = false WHERE ("user_id" IS NULL OR "user_id" <> 'system') AND "shared" = true;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "shared_memory_enabled" boolean DEFAULT false NOT NULL;