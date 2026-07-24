CREATE TABLE "agent_orchestration_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"task" text NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_orchestration_plan_items_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "agent_orchestration_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_orchestration_plans_plan_id_unique" UNIQUE("plan_id")
);
--> statement-breakpoint
ALTER TABLE "agent_orchestration_plan_items" ADD CONSTRAINT "agent_orchestration_plan_items_plan_id_agent_orchestration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."agent_orchestration_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_orchestration_plan_items_plan_idx" ON "agent_orchestration_plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "agent_orchestration_plan_items_item_idx" ON "agent_orchestration_plan_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "agent_orchestration_plans_session_idx" ON "agent_orchestration_plans" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_orchestration_plans_status_idx" ON "agent_orchestration_plans" USING btree ("status");