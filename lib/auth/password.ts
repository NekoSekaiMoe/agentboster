import { compare, genSalt, hash } from 'bcryptjs';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = await genSalt(SALT_ROUNDS);
  return hash(password, salt);
}

export async function verifyPassword(
  password: string,
  hashValue: string,
): Promise<boolean> {
  return compare(password, hashValue);
}
