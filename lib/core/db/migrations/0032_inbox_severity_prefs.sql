ALTER TABLE "notification_preferences" ADD COLUMN "muted_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "severity" text DEFAULT 'attention' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_unarchived_idx" ON "notifications" USING btree ("user_id","archived_at") WHERE "notifications"."archived_at" IS NULL;