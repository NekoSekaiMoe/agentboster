import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * System-level vault entries.
 *
 * Holds credentials that must be reachable across users and execution
 * planes — notably MCP OAuth token bundles (`mcp:oauth:<server>`, see
 * `lib/mcp/oauth-store.ts`) and remote knowledge-provider API keys
 * (`<provider>:<kbId>`, see `lib/knowledge/index.ts`). These are NOT
 * user-private data; they are system secrets shared by the agents and
 * daemons that need them. The `/api/agentd/v1/vault/list` route reads
 * this table (gated by the shared `AGENTD_API_KEY`).
 *
 * For user-private entries, see {@link userVaultEntries}.
 */
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

/**
 * User-private vault entries.
 *
 * Per-user encrypted secrets accessed via the web `/api/vault/*` routes.
 * Every row is owned by exactly one user (`userId` is NOT NULL); queries
 * MUST filter `WHERE userId = ?`. The `(userId, key)` unique index allows
 * the same key name to exist independently for different users.
 *
 * This split from {@link vaultEntries} exists because the vault was
 * historically a single shared store: a user could list/read/overwrite
 * any entry (including system MCP OAuth bundles) because the web routes
 * passed `userId` only as an audit-log field, never into the WHERE
 * clause. System secrets now live in `vault_entries`; user secrets live
 * here, and the two stores are fully isolated.
 */
export const userVaultEntries = pgTable(
  'user_vault_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userKeyIdx: uniqueIndex('user_vault_entries_user_id_key_idx').on(
      table.userId,
      table.key,
    ),
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
