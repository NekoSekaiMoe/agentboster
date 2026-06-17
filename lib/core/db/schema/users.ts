import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { UserModelPreferences } from '@/types/config/user-preferences';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: text('roles').array().default(['user']).notNull(),
    modelPreferences: jsonb('model_preferences').$type<UserModelPreferences>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    usernameIdx: uniqueIndex('users_username_idx').on(table.username),
  }),
);
