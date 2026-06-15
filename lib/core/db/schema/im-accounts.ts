import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const imAccounts = pgTable(
  'im_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clawlessUserId: uuid('clawless_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    adapter: text('adapter').notNull(),
    imUserId: text('im_user_id').notNull(),
    imUserName: text('im_user_name'),
    pairedAt: timestamp('paired_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    unpairedAt: timestamp('unpaired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    adapterImUserIdIdx: uniqueIndex('im_accounts_adapter_im_user_id_idx').on(
      table.adapter,
      table.imUserId,
    ),
    clawlessUserAdapterIdx: uniqueIndex(
      'im_accounts_clawless_user_adapter_idx',
    ).on(table.clawlessUserId, table.adapter),
  }),
);
