import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Paired CLI devices.
 *
 * Each row corresponds to one successful `agentboster login --pair-code`
 * exchange. The `tokenJti` column stores the device id embedded in the
 * issued auth token's payload, so the token can be validated against
 * this row to check revocation without storing the token itself.
 */
export const cliDevices = pgTable(
  'cli_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clawlessUserId: uuid('clawless_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    tokenJti: text('token_jti').notNull(),
    pairedAt: timestamp('paired_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenJtiIdx: uniqueIndex('cli_devices_token_jti_idx').on(table.tokenJti),
    clawlessUserIdx: uniqueIndex('cli_devices_clawless_user_id_idx').on(
      table.clawlessUserId,
    ),
  }),
);
