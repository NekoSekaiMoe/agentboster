import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '@/lib/extra/auth/password';
import { db } from '@/lib/core/db';
import { users } from '@/lib/core/db/schema';

export interface StoredUser {
  id: string;
  username: string;
  roles: string[];
  createdAt: Date;
}

export async function createUser(
  username: string,
  password: string,
): Promise<StoredUser> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(`User "${username}" already exists.`);
  }

  const passwordHash = await hashPassword(password);
  const result = await db
    .insert(users)
    .values({ username, passwordHash, roles: ['user'] })
    .returning({
      id: users.id,
      username: users.username,
      roles: users.roles,
      createdAt: users.createdAt,
    });

  return result[0];
}

export async function authenticateUser(
  username: string,
  password: string,
): Promise<StoredUser | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  const isValid = await verifyPassword(password, row.passwordHash);
  if (!isValid) return null;

  return {
    id: row.id,
    username: row.username,
    roles: row.roles as string[],
    createdAt: row.createdAt,
  };
}

export async function getUserById(
  userId: string,
): Promise<StoredUser | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    username: row.username,
    roles: row.roles as string[],
    createdAt: row.createdAt,
  };
}

export async function listUsers(): Promise<StoredUser[]> {
  const rows = await db.select().from(users);
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    roles: row.roles as string[],
    createdAt: row.createdAt,
  }));
}

export async function deleteUser(userId: string): Promise<boolean> {
  const result = await db.delete(users).where(eq(users.id, userId));
  return (result.rowCount ?? 0) > 0;
}

export async function userCount(): Promise<number> {
  const result = await db.select({ id: users.id }).from(users);
  return result.length;
}

export async function seedInitialUser(): Promise<void> {
  const count = await userCount();
  if (count > 0) return;

  const username = process.env.USERNAME?.trim();
  const password = process.env.PASSWORD?.trim();
  if (!username || !password) return;

  try {
    await createUser(username, password);
    console.log(`[auth] Seeded initial user "${username}" from env vars.`);
  } catch (err) {
    console.error('[auth] Failed to seed initial user:', err);
  }
}
