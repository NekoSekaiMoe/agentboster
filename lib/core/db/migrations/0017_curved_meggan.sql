CREATE TABLE "agent_barrier_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrier_id" text NOT NULL,
	"barrier_stable_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"payload" jsonb,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_barriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrier_id" text NOT NULL,
	"session_id" uuid,
	"run_id" text,
	"expected" integer NOT NULL,
	"released" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'all' NOT NULL,
	"quorum" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "agent_barriers_barrier_id_unique" UNIQUE("barrier_id")
);
--> statement-breakpoint
CREATE TABLE "agent_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_session_id" uuid,
	"to_session_id" uuid,
	"run_id" text,
	"barrier_id" text,
	"key" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_subagent_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" text NOT NULL,
	"session_id" uuid,
	"run_id" text,
	"barrier_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"concurrency_limit" integer DEFAULT 1 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_subagent_batches_batch_id_unique" UNIQUE("batch_id")
);
--> statement-breakpoint
CREATE TABLE "agent_subagent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subagent_id" text NOT NULL,
	"batch_stable_id" text NOT NULL,
	"session_id" uuid,
	"agent_name" text NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model_id" text,
	"steps" integer,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_subagent_jobs_subagent_id_unique" UNIQUE("subagent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_barrier_releases" ADD CONSTRAINT "agent_barrier_releases_barrier_id_agent_barriers_barrier_id_fk" FOREIGN KEY ("barrier_id") REFERENCES "public"."agent_barriers"("barrier_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_barrier_id_agent_barriers_barrier_id_fk" FOREIGN KEY ("barrier_id") REFERENCES "public"."agent_barriers"("barrier_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subagent_batches" ADD CONSTRAINT "agent_subagent_batches_barrier_id_agent_barriers_barrier_id_fk" FOREIGN KEY ("barrier_id") REFERENCES "public"."agent_barriers"("barrier_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_barrier_releases_barrier_idx" ON "agent_barrier_releases" USING btree ("barrier_stable_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_barrier_releases_barrier_participant_idx" ON "agent_barrier_releases" USING btree ("barrier_stable_id","participant_id");--> statement-breakpoint
CREATE INDEX "agent_barriers_status_idx" ON "agent_barriers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_barriers_session_idx" ON "agent_barriers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_barriers_run_idx" ON "agent_barriers" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_handoffs_to_key_idx" ON "agent_handoffs" USING btree ("to_session_id","key");--> statement-breakpoint
CREATE INDEX "agent_handoffs_from_key_idx" ON "agent_handoffs" USING btree ("from_session_id","key");--> statement-breakpoint
CREATE INDEX "agent_handoffs_barrier_idx" ON "agent_handoffs" USING btree ("barrier_id");--> statement-breakpoint
CREATE INDEX "agent_subagent_batches_session_idx" ON "agent_subagent_batches" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_subagent_batches_status_idx" ON "agent_subagent_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_subagent_batches_barrier_idx" ON "agent_subagent_batches" USING btree ("barrier_id");--> statement-breakpoint
CREATE INDEX "agent_subagent_jobs_batch_idx" ON "agent_subagent_jobs" USING btree ("batch_stable_id");--> statement-breakpoint
CREATE INDEX "agent_subagent_jobs_session_idx" ON "agent_subagent_jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_subagent_jobs_status_idx" ON "agent_subagent_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_subagent_jobs_subagent_id_idx" ON "agent_subagent_jobs" USING btree ("subagent_id");