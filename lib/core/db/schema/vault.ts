import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const vaultEntries = pgTable(
  'vault_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    nonce: text('nonce').notNull(),
    createdByUserId: text('created_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex('vault_entries_key_idx').on(table.key),
  }),
);

export const vaultAuditLogs = pgTable('vault_audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull(),
  action: text('action').notNull(),
  userId: text('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
