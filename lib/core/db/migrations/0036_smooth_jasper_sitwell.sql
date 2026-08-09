ALTER TABLE "l2_decisions" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "l2_decisions_user_idx" ON "l2_decisions" USING btree ("user_id");