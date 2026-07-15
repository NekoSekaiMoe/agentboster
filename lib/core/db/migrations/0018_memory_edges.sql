CREATE TABLE IF NOT EXISTS "memory_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"src_memory_id" uuid NOT NULL,
	"dst_memory_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_edges_src_memory_id_long_term_memories_id_fk"
		FOREIGN KEY ("src_memory_id") REFERENCES "long_term_memories"("id") ON DELETE cascade,
	CONSTRAINT "memory_edges_dst_memory_id_long_term_memories_id_fk"
		FOREIGN KEY ("dst_memory_id") REFERENCES "long_term_memories"("id") ON DELETE cascade,
	CONSTRAINT "memory_edges_relation_check"
		CHECK ("relation" IN ('same_topic', 'related', 'supersedes', 'contradicts'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_edges_src_idx"
	ON "memory_edges" ("src_memory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_edges_dst_idx"
	ON "memory_edges" ("dst_memory_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_edges_unique_idx"
	ON "memory_edges" ("src_memory_id", "dst_memory_id", "relation");
