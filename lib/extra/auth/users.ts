import { createApiKey } from './api-keys';
import { hashPassword, verifyPassword } from './password';
import type { ApiKey, User } from './types';

interface StoredUser extends User {
  passwordHash: string;
}

const users = new Map<string, StoredUser>();
const apiKeyIndex = new Map<string, string>();

export async function createUser(
  username: string,
  password: string,
): Promise<User> {
  const existing = Array.from(users.values()).find(
    (u) => u.username === username,
  );
  if (existing) {
    throw new Error(`User "${username}" already exists.`);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const user: StoredUser = {
    id,
    username,
    passwordHash,
    roles: ['user'],
    apiKeys: [],
    createdAt: Math.floor(Date.now() / 1000),
  };

  users.set(id, user);
  return toPublicUser(user);
}

export async function authenticateUser(
  username: string,
  password: string,
): Promise<User | null> {
  const user = Array.from(users.values()).find((u) => u.username === username);
  if (!user) return null;

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) return null;

  return toPublicUser(user);
}

export function getUserById(userId: string): User | null {
  const user = users.get(userId);
  return user ? toPublicUser(user) : null;
}

export function getUserByApiKey(key: string): User | null {
  const userId = apiKeyIndex.get(key);
  if (!userId) return null;
  return getUserById(userId);
}

export async function changeUserPassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const user = users.get(userId);
  if (!user) throw new Error('User not found.');

  const isValid = await verifyPassword(oldPassword, user.passwordHash);
  if (!isValid) throw new Error('Invalid current password.');

  user.passwordHash = await hashPassword(newPassword);
}

export function addApiKeyToUser(
  userId: string,
  name: string,
  scopes: string[],
  expiresAt?: number,
): ApiKey {
  const user = users.get(userId);
  if (!user) throw new Error('User not found.');

  const apiKey = createApiKey(name, scopes, expiresAt);
  user.apiKeys.push(apiKey);
  apiKeyIndex.set(apiKey.key, userId);
  return apiKey;
}

export function listUsers(): User[] {
  return Array.from(users.values()).map(toPublicUser);
}

export function deleteUser(userId: string): boolean {
  const user = users.get(userId);
  if (!user) return false;

  for (const apiKey of user.apiKeys) {
    apiKeyIndex.delete(apiKey.key);
  }
  users.delete(userId);
  return true;
}

function toPublicUser(user: StoredUser): User {
  return {
    id: user.id,
    username: user.username,
    passwordHash: undefined,
    roles: user.roles,
    apiKeys: user.apiKeys,
    createdAt: user.createdAt,
  };
}
