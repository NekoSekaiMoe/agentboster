-- Add real per-user ownership column to notifications.
-- See lib/core/db/schema/notification.ts: `userId` is the agentboster user who
-- owns the notification (derived server-side from the task/session owner);
-- `targetUserId` (already present) is the IM-platform delivery target and is
-- NOT a tenancy boundary. List/read queries should filter WHERE user_id = ?.
ALTER TABLE "notifications" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");
