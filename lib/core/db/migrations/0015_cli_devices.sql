CREATE TABLE IF NOT EXISTS "cli_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clawless_user_id" uuid NOT NULL,
	"label" text,
	"token_jti" text NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_devices_clawless_user_id_users_id_fk"
		FOREIGN KEY ("clawless_user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cli_devices_token_jti_idx"
	ON "cli_devices" ("token_jti");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cli_devices_clawless_user_id_idx"
	ON "cli_devices" ("clawless_user_id");
