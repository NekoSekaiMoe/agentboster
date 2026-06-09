CREATE TABLE IF NOT EXISTS "knowledge_connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_base_id" uuid NOT NULL REFERENCES "knowledge_bases"("id") ON DELETE cascade,
  "provider" text DEFAULT 'url' NOT NULL,
  "name" text NOT NULL,
  "source_uri" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sync_status" text DEFAULT 'idle' NOT NULL,
  "last_document_id" uuid REFERENCES "knowledge_documents"("id") ON DELETE set null,
  "last_synced_at" timestamp with time zone,
  "last_error" text,
  "config" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_connectors_provider_check'
  ) THEN
    ALTER TABLE "knowledge_connectors"
      ADD CONSTRAINT "knowledge_connectors_provider_check"
      CHECK ("provider" IN ('url'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_connectors_sync_status_check'
  ) THEN
    ALTER TABLE "knowledge_connectors"
      ADD CONSTRAINT "knowledge_connectors_sync_status_check"
      CHECK ("sync_status" IN ('idle', 'syncing', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "knowledge_connectors_kb_created_idx"
  ON "knowledge_connectors" ("knowledge_base_id", "created_at");

CREATE INDEX IF NOT EXISTS "knowledge_connectors_provider_idx"
  ON "knowledge_connectors" ("provider", "enabled");
