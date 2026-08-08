-- User-private vault entries, split from the system-level vault_entries.
-- See lib/core/db/schema/vault.ts for the rationale: vault_entries holds
-- system secrets (MCP OAuth bundles, knowledge-provider API keys) reachable
-- across users; user_vault_entries holds per-user secrets accessed via the
-- web /api/vault/* routes. Every query MUST filter WHERE user_id = ?.
CREATE TABLE "user_vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "user_vault_entries_user_id_key_idx" ON "user_vault_entries" USING btree ("user_id","key");
