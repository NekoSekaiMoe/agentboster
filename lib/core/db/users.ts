import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '@/lib/extra/auth/password';
import { db } from '@/lib/core/db';
import { users } from '@/lib/core/db/schema';

export const ALL_ROLES = [
  'owner',
  'root',
  'admin',
  'user',
  'readonly',
] as const;

export const PROTECTED_ROLES = ['owner', 'root'] as const;

export type UserRole = (typeof ALL_ROLES)[number];
export type MinUserType = 'root' | 'admin' | 'user' | 'unknown';

const ALL_ROLE_SET = new Set<string>(ALL_ROLES);
const PROTECTED_ROLE_SET = new Set<string>(PROTECTED_ROLES);

export interface StoredUser {
  id: string;
  username: string;
  roles: string[];
  createdAt: Date;
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

export function resolveMinUserType(
  roles: readonly string[] | null | undefined,
): MinUserType {
  if (!roles || roles.length === 0) {
    return 'unknown';
  }
  if (roles.some((role) => role === 'owner' || role === 'root')) {
    return 'root';
  }
  if (roles.includes('admin')) {
    return 'admin';
  }
  if (roles.includes('user')) {
    return 'user';
  }
  return 'unknown';
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
