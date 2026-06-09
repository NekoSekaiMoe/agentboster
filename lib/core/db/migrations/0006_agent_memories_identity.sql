ALTER TABLE "agent_memories"
  ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "sessions"("id") ON DELETE cascade;

ALTER TABLE "agent_memories"
  ADD COLUMN IF NOT EXISTS "user_id" text;

UPDATE "agent_memories" AS "memory"
SET
  "session_id" = "session"."id",
  "user_id" = COALESCE("memory"."user_id", "session"."user_id")
FROM "sessions" AS "session"
WHERE
  "memory"."session_id" IS NULL
  AND "memory"."source" = "session"."id"::text;

UPDATE "agent_memories" AS "memory"
SET "user_id" = "session"."user_id"
FROM "sessions" AS "session"
WHERE
  "memory"."session_id" = "session"."id"
  AND "memory"."user_id" IS NULL;

CREATE INDEX IF NOT EXISTS "agent_memories_agent_user_created_idx"
  ON "agent_memories" ("agent_id", "user_id", "created_at");

CREATE INDEX IF NOT EXISTS "agent_memories_agent_session_created_idx"
  ON "agent_memories" ("agent_id", "session_id", "created_at");
