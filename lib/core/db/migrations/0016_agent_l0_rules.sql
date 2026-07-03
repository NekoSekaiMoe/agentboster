CREATE TABLE "agent_l0_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text DEFAULT 'global' NOT NULL,
	"pattern" text NOT NULL,
	"type" text NOT NULL,
	"action" text NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
