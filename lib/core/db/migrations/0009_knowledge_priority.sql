ALTER TABLE "knowledge_bases"
  ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "knowledge_bases_agent_priority_idx"
  ON "knowledge_bases" ("agent_id", "priority", "enabled");
