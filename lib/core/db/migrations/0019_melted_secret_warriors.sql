CREATE TABLE "kv_sets" (
	"key" text NOT NULL,
	"member" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kv_sets_key_member_pk" PRIMARY KEY("key","member")
);
--> statement-breakpoint
CREATE TABLE "kv_store" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"src_memory_id" uuid NOT NULL,
	"dst_memory_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_edges_relation_check" CHECK ("memory_edges"."relation" IN ('same_topic', 'related', 'supersedes', 'contradicts'))
);
--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_src_memory_id_long_term_memories_id_fk" FOREIGN KEY ("src_memory_id") REFERENCES "public"."long_term_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_dst_memory_id_long_term_memories_id_fk" FOREIGN KEY ("dst_memory_id") REFERENCES "public"."long_term_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kv_sets_expires_at_idx" ON "kv_sets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "kv_store_expires_at_idx" ON "kv_store" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "memory_edges_src_idx" ON "memory_edges" USING btree ("src_memory_id");--> statement-breakpoint
CREATE INDEX "memory_edges_dst_idx" ON "memory_edges" USING btree ("dst_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_edges_unique_idx" ON "memory_edges" USING btree ("src_memory_id","dst_memory_id","relation");