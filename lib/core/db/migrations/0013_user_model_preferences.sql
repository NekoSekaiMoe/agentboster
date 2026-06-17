-- Per-user model preferences. Stored as jsonb so future per-user fields
-- (temperature, context_limit, etc.) can be added without a new migration.
-- Currently only { model?: string } is read/written.
ALTER TABLE "users"
	ADD COLUMN IF NOT EXISTS "model_preferences" jsonb;
