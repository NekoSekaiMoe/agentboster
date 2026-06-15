-- Adds `kind` to knowledge_bases to distinguish local (in-Postgres) from
-- remote (real-time proxied) knowledge bases, and broadens the
-- `knowledge_connectors.provider` check constraint to allow 'mem0' and 'http'.

ALTER TABLE "knowledge_bases"
  ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'local' NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_connectors_provider_check'
  ) THEN
    ALTER TABLE "knowledge_connectors"
      DROP CONSTRAINT "knowledge_connectors_provider_check";
  END IF;

  ALTER TABLE "knowledge_connectors"
    ADD CONSTRAINT "knowledge_connectors_provider_check"
    CHECK ("provider" IN ('url', 'mem0', 'http'));
END $$;

-- Optional: relax the NOT NULL on source_uri so remote connectors can store
-- the search endpoint elsewhere (knowledgeConnectors.config jsonb). We keep it
-- NOT NULL for backward compat and store endpoint URL in source_uri for remote
-- providers as well, so no change needed.
