import {
  createUser as dbCreateUser,
  authenticateUser as dbAuthenticateUser,
  getUserById as dbGetUserById,
  listUsers as dbListUsers,
  deleteUser as dbDeleteUser,
} from '@/lib/core/db/users';
import { hashPassword, verifyPassword } from './password';
import { createApiKey } from './api-keys';
import type { ApiKey } from './types';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { users } from '@/lib/core/db/schema';

const apiKeyIndex = new Map<string, string>();

export async function createUser(
  username: string,
  password: string,
) {
  return dbCreateUser(username, password);
}

export async function authenticateUser(
  username: string,
  password: string,
) {
  return dbAuthenticateUser(username, password);
}

export async function getUserById(userId: string) {
  return dbGetUserById(userId);
}

export async function changeUserPassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (rows.length === 0) throw new Error('User not found.');

  const isValid = await verifyPassword(oldPassword, rows[0].passwordHash);
  if (!isValid) throw new Error('Invalid current password.');

  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function listUsers() {
  return dbListUsers();
}

export async function deleteUser(userId: string): Promise<boolean> {
  return dbDeleteUser(userId);
}

export function addApiKeyToUser(
  userId: string,
  name: string,
  scopes: string[],
  expiresAt?: number,
): ApiKey {
  const apiKey = createApiKey(name, scopes, expiresAt);
  apiKeyIndex.set(apiKey.key, userId);
  return apiKey;
}

export function getUserByApiKey(key: string) {
  const userId = apiKeyIndex.get(key);
  if (!userId) return null;
  return null;
}
