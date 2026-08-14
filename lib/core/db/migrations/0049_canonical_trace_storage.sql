CREATE TABLE "trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text,
	"parent_span_id" text,
	"sequence" bigint NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"user_id" text,
	"session_id" uuid,
	"task_id" uuid,
	"workspace_id" uuid,
	"node_id" text,
	"agent_id" text,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_runs" (
	"trace_id" text PRIMARY KEY NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"user_id" text,
	"session_id" uuid,
	"task_id" uuid,
	"workspace_id" uuid,
	"node_id" text,
	"agent_id" text,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	"next_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"sequence" bigint NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"user_id" text,
	"session_id" uuid,
	"task_id" uuid,
	"workspace_id" uuid,
	"node_id" text,
	"agent_id" text,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_events_trace_event_uniq" ON "trace_events" USING btree ("trace_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_events_idempotency_uniq" ON "trace_events" USING btree ("trace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trace_events_trace_sequence_idx" ON "trace_events" USING btree ("trace_id","sequence","event_id");--> statement-breakpoint
CREATE INDEX "trace_events_user_started_idx" ON "trace_events" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_runs_idempotency_uniq" ON "trace_runs" USING btree ("trace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trace_runs_user_started_idx" ON "trace_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "trace_runs_session_started_idx" ON "trace_runs" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "trace_runs_workspace_started_idx" ON "trace_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_spans_trace_span_uniq" ON "trace_spans" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_spans_idempotency_uniq" ON "trace_spans" USING btree ("trace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trace_spans_trace_sequence_idx" ON "trace_spans" USING btree ("trace_id","sequence","span_id");--> statement-breakpoint
CREATE INDEX "trace_spans_user_started_idx" ON "trace_spans" USING btree ("user_id","started_at");