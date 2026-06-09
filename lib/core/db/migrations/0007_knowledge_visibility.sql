ALTER TABLE "knowledge_bases"
  ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "knowledge_bases"
  ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'team' NOT NULL;

UPDATE "knowledge_bases"
SET "visibility" = 'team'
WHERE "visibility" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_bases_visibility_check'
  ) THEN
    ALTER TABLE "knowledge_bases"
      ADD CONSTRAINT "knowledge_bases_visibility_check"
      CHECK ("visibility" IN ('team', 'private'));
  END IF;
END $$;

DROP INDEX IF EXISTS "knowledge_bases_agent_name_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_bases_team_agent_name_idx"
  ON "knowledge_bases" ("agent_id", "name")
  WHERE "visibility" = 'team';

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_bases_private_owner_agent_name_idx"
  ON "knowledge_bases" ("agent_id", "owner_user_id", "name")
  WHERE "visibility" = 'private';

CREATE INDEX IF NOT EXISTS "knowledge_bases_agent_visibility_enabled_idx"
  ON "knowledge_bases" ("agent_id", "visibility", "enabled");

CREATE INDEX IF NOT EXISTS "knowledge_bases_owner_visibility_idx"
  ON "knowledge_bases" ("owner_user_id", "visibility");
