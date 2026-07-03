import { db } from '@/lib/core/db';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('[ensure-l0-rules] checking agent_l0_rules table');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_l0_rules" (
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
  `);

  console.log('[ensure-l0-rules] table ready');
}

main().catch((error) => {
  console.error('[ensure-l0-rules] failed:', error);
  process.exit(1);
});
