CREATE TABLE "agent_tool_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"session_id" uuid,
	"agent_id" text NOT NULL,
	"user_id" text,
	"roles" text[],
	"source" jsonb,
	"sandbox_id" text,
	"model" text,
	"step" integer,
	"tool_call_id" text,
	"tool_name" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"arguments" jsonb,
	"result" jsonb,
	"output_text" text,
	"success" boolean DEFAULT false NOT NULL,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archived_task_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" uuid,
	"workspace_id" uuid,
	"status" text NOT NULL,
	"progress" text,
	"decisions" jsonb,
	"pending" jsonb,
	"known_issues" jsonb,
	"version" integer NOT NULL,
	"last_updated" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text DEFAULT 'global' NOT NULL,
	"owner_user_id" uuid,
	"visibility" text DEFAULT 'team' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"emoji" text DEFAULT 'book' NOT NULL,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"chunk_size" integer DEFAULT 1000 NOT NULL,
	"chunk_overlap" integer DEFAULT 120 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"tsv" "tsvector",
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"provider" text DEFAULT 'url' NOT NULL,
	"name" text NOT NULL,
	"source_uri" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"last_document_id" uuid,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text DEFAULT 'text' NOT NULL,
	"source_uri" text,
	"content_hash" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"roles" text[] DEFAULT '{"user"}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"nonce" text NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_summaries" DROP CONSTRAINT "task_summaries_task_id_unique";--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_review_logs" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_review_logs" ADD COLUMN "roles" text[];--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "agentd_nodes" ADD COLUMN "cpu_model" text;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "memory_type" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memories" ADD COLUMN "importance" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "long_term_memory_chunks" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "soul_content" text;--> statement-breakpoint
ALTER TABLE "task_summaries" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_summaries" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_connectors" ADD CONSTRAINT "knowledge_connectors_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_connectors" ADD CONSTRAINT "knowledge_connectors_last_document_id_knowledge_documents_id_fk" FOREIGN KEY ("last_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tool_activity_logs_task_idx" ON "agent_tool_activity_logs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_tool_activity_logs_session_idx" ON "agent_tool_activity_logs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_tool_activity_logs_agent_created_idx" ON "agent_tool_activity_logs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tool_activity_logs_tool_created_idx" ON "agent_tool_activity_logs" USING btree ("tool_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_team_agent_name_idx" ON "knowledge_bases" USING btree ("agent_id","name") WHERE "knowledge_bases"."visibility" = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_private_owner_agent_name_idx" ON "knowledge_bases" USING btree ("agent_id","owner_user_id","name") WHERE "knowledge_bases"."visibility" = 'private';--> statement-breakpoint
CREATE INDEX "knowledge_bases_agent_visibility_enabled_idx" ON "knowledge_bases" USING btree ("agent_id","visibility","enabled");--> statement-breakpoint
CREATE INDEX "knowledge_bases_owner_visibility_idx" ON "knowledge_bases" USING btree ("owner_user_id","visibility");--> statement-breakpoint
CREATE INDEX "knowledge_bases_agent_enabled_idx" ON "knowledge_bases" USING btree ("agent_id","enabled");--> statement-breakpoint
CREATE INDEX "knowledge_bases_agent_priority_idx" ON "knowledge_bases" USING btree ("agent_id","priority","enabled");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_kb_chunk_idx" ON "knowledge_chunks" USING btree ("knowledge_base_id","chunk_index");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_chunk_idx" ON "knowledge_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_lookup_idx" ON "knowledge_chunks" USING btree ("embedding_model","embedding_dimensions");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "knowledge_connectors_kb_created_idx" ON "knowledge_connectors" USING btree ("knowledge_base_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_connectors_provider_idx" ON "knowledge_connectors" USING btree ("provider","enabled");--> statement-breakpoint
CREATE INDEX "knowledge_documents_kb_created_idx" ON "knowledge_documents" USING btree ("knowledge_base_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_documents_source_idx" ON "knowledge_documents" USING btree ("knowledge_base_id","source_type");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_entries_key_idx" ON "vault_entries" USING btree ("key");--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_agent_user_created_idx" ON "agent_memories" USING btree ("agent_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_memories_agent_session_created_idx" ON "agent_memories" USING btree ("agent_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "long_term_memories_memory_type_idx" ON "long_term_memories" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "task_summaries_task_current_idx" ON "task_summaries" USING btree ("task_id","is_current");