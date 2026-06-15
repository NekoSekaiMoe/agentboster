CREATE TABLE IF NOT EXISTS "im_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clawless_user_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"im_user_id" text NOT NULL,
	"im_user_name" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unpaired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "im_accounts_clawless_user_id_users_id_fk"
		FOREIGN KEY ("clawless_user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "im_accounts_adapter_im_user_id_idx"
	ON "im_accounts" ("adapter", "im_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "im_accounts_clawless_user_adapter_idx"
	ON "im_accounts" ("clawless_user_id", "adapter");
