-- Dream system audit table (ref/ AutoGPT dream/* offline memory consolidation).
--
-- Stores one row per (user, dream run) with the full sanitized operation
-- list + aggregate result, so any memory written by Dream can be traced
-- back to the run that produced it and the source memories it came from.
--
-- Read-only after insert. Keep it append-only: no UPDATE path exists,
-- failed runs still record a row with result.apply.failed > 0.
CREATE TABLE "dream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamptz DEFAULT now() NOT NULL,
	"finished_at" timestamptz,
	"phases" text NOT NULL,
	"operations" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "dream_runs_user_started_idx" ON "dream_runs" ("user_id","started_at");
