import { eq } from 'drizzle-orm';
import { hashPassword } from '@/lib/auth/password';
import { db } from '@/lib/core/db';
import { users } from '@/lib/core/db/schema';
import type { UserModelPreferences } from '@/types/config/user-preferences';

const ALL_ROLES = ['owner', 'root', 'admin', 'user', 'readonly'] as const;

const PROTECTED_ROLES = ['owner', 'root'] as const;

export type UserRole = (typeof ALL_ROLES)[number];

const ALL_ROLE_SET = new Set<string>(ALL_ROLES);
const PROTECTED_ROLE_SET = new Set<string>(PROTECTED_ROLES);

export interface StoredUser {
  id: string;
  username: string;
  roles: string[];
  /**
   * Per-user overrides for the user's own chat / memory runs. Background
   * tasks ignore this field. `null`/undefined means "use global defaults".
   */
  modelPreferences: UserModelPreferences | null;
  createdAt: Date;
}

function readSeedAdminUsernames() {
  return [
    process.env.OWNER_USERNAME?.trim(),
    process.env.USERNAME?.trim(),
  ].filter((value): value is string => Boolean(value));
}

export function normalizeRoles(value?: unknown): UserRole[] {
  if (!Array.isArray(value)) {
    return ['user'];
  }

  const roles = value
    .filter((role): role is string => typeof role === 'string')
    .map((role) => role.trim())
    .filter((role): role is UserRole => ALL_ROLE_SET.has(role));

  const unique = [...new Set(roles)];
  return unique.length > 0 ? unique : ['user'];
}

export function invalidRoles(value?: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (role) => typeof role !== 'string' || !ALL_ROLE_SET.has(role.trim()),
    )
    .map((role) => String(role));
}

export function hasOwnerRole(roles: readonly string[] = []): boolean {
  return roles.some((role) => role === 'owner' || role === 'root');
}

export function hasAdminRole(roles: readonly string[] = []): boolean {
  return hasOwnerRole(roles) || roles.includes('admin');
}

export function canGrantRoles(
  granterRoles: readonly string[],
  targetRoles: readonly string[],
): boolean {
  if (!hasAdminRole(granterRoles)) {
    return false;
  }

  const grantsProtectedRole = targetRoles.some((role) =>
    PROTECTED_ROLE_SET.has(role),
  );
  return !grantsProtectedRole || hasOwnerRole(granterRoles);
}

export function isSeedAdminUsername(username: string): boolean {
  return readSeedAdminUsernames().includes(username);
}

export function isSeedAdminUser(user: Pick<StoredUser, 'username'>): boolean {
  return isSeedAdminUsername(user.username);
}

export async function createUser(
  username: string,
  password: string,
  options?: { roles?: string[] },
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
  const roles = normalizeRoles(options?.roles);
  const result = await db
    .insert(users)
    .values({ username, passwordHash, roles })
    .returning({
      id: users.id,
      username: users.username,
      roles: users.roles,
      modelPreferences: users.modelPreferences,
      createdAt: users.createdAt,
    });

  return result[0];
}

export async function getUserById(userId: string): Promise<StoredUser | null> {
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
    modelPreferences: (row.modelPreferences ??
      null) as UserModelPreferences | null,
    createdAt: row.createdAt,
  };
}

export async function listUsers(): Promise<StoredUser[]> {
  const rows = await db.select().from(users);
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    roles: row.roles as string[],
    modelPreferences: (row.modelPreferences ??
      null) as UserModelPreferences | null,
    createdAt: row.createdAt,
  }));
}

export async function updateUserRoles(
  userId: string,
  roles: string[],
): Promise<StoredUser | null> {
  const normalizedRoles = normalizeRoles(roles);
  const [row] = await db
    .update(users)
    .set({
      roles: normalizedRoles,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      roles: users.roles,
      modelPreferences: users.modelPreferences,
      createdAt: users.createdAt,
    });

  return row ?? null;
}

export async function updateUserPassword(
  userId: string,
  password: string,
): Promise<StoredUser | null> {
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(users)
    .set({
      passwordHash,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      roles: users.roles,
      modelPreferences: users.modelPreferences,
      createdAt: users.createdAt,
    });

  return row ?? null;
}

/**
 * Replace the per-user model preferences for the given user. Pass `null` to
 * clear (fall back to global defaults). Returns the updated user or null if
 * no user matched.
 */
export async function updateUserModelPreferences(
  userId: string,
  preferences: UserModelPreferences | null,
): Promise<StoredUser | null> {
  const [row] = await db
    .update(users)
    .set({
      modelPreferences: preferences,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      roles: users.roles,
      modelPreferences: users.modelPreferences,
      createdAt: users.createdAt,
    });

  return row ?? null;
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

  const ownerUsername = process.env.OWNER_USERNAME?.trim();
  const ownerPassword =
    process.env.OWNER_PASSWORD?.trim() || process.env.PASSWORD?.trim();
  const username = process.env.USERNAME?.trim();
  const password = process.env.PASSWORD?.trim();

  try {
    if (ownerUsername) {
      if (!ownerPassword) {
        console.error(
          '[auth] OWNER_USERNAME is set but OWNER_PASSWORD/PASSWORD is missing.',
        );
        return;
      }

      await createUser(ownerUsername, ownerPassword, { roles: ['owner'] });
      console.log(`[auth] Seeded owner user "${ownerUsername}" from env vars.`);
      return;
    }

    if (!username || !password) return;

    await createUser(username, password, { roles: ['admin'] });
    console.log(`[auth] Seeded admin user "${username}" from env vars.`);
  } catch (err) {
    console.error('[auth] Failed to seed initial user:', err);
  }
}
