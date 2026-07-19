import * as crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { vaultAuditLogs, vaultEntries } from '@/lib/core/db/schema';

const NONCE_BYTES = 12;
const MASTER_KEY_ENV = 'VAULT_MASTER_KEY';
const PREVIOUS_MASTER_KEY_ENV = 'VAULT_MASTER_KEY_PREVIOUS';

function deriveKey(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function getMasterKey(envName: string): Buffer | null {
  const raw = process.env[envName]?.trim();
  return raw ? deriveKey(raw) : null;
}

function requireMasterKey(): Buffer {
  const key = getMasterKey(MASTER_KEY_ENV);
  if (!key) {
    throw new Error(`${MASTER_KEY_ENV} is not configured.`);
  }
  return key;
}

function validateVaultKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(normalized)) {
    throw new Error(
      'Vault key must be 1-128 chars and contain only letters, numbers, _, ., :, or -.',
    );
  }
  return normalized;
}

function encryptValue(value: string): {
  encryptedValue: string;
  nonce: string;
} {
  const key = requireMasterKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encryptedValue: `${tag.toString('base64')}:${ciphertext.toString('base64')}`,
    nonce: nonce.toString('base64'),
  };
}

function decryptWithKey(input: {
  encryptedValue: string;
  nonce: string;
  key: Buffer;
}): string {
  const [tagText, ciphertextText] = input.encryptedValue.split(':');
  if (!tagText || !ciphertextText) {
    throw new Error('Invalid vault ciphertext format.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    input.key,
    Buffer.from(input.nonce, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decryptValue(input: {
  encryptedValue: string;
  nonce: string;
}): string {
  const keys = [
    getMasterKey(MASTER_KEY_ENV),
    getMasterKey(PREVIOUS_MASTER_KEY_ENV),
  ].filter((key): key is Buffer => Boolean(key));

  if (keys.length === 0) {
    throw new Error(`${MASTER_KEY_ENV} is not configured.`);
  }

  let lastError: unknown;
  for (const key of keys) {
    try {
      return decryptWithKey({ ...input, key });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to decrypt vault value.');
}

async function auditVault(
  action: string,
  key: string,
  userId?: string | null,
  tx: Pick<typeof db, 'insert'> = db,
) {
  await tx.insert(vaultAuditLogs).values({
    action,
    key,
    userId: userId ?? null,
  });
}

export async function listVaultEntries(userId?: string | null) {
  const entries = await db
    .select({
      key: vaultEntries.key,
      createdAt: vaultEntries.createdAt,
      updatedAt: vaultEntries.updatedAt,
    })
    .from(vaultEntries)
    .orderBy(desc(vaultEntries.updatedAt));

  await auditVault('list', '*', userId);
  return entries;
}

export async function listVaultKeyNames() {
  const entries = await db
    .select({ key: vaultEntries.key })
    .from(vaultEntries)
    .orderBy(desc(vaultEntries.updatedAt));
  await auditVault('agentd_list', '*', null);
  return entries.map((entry) => entry.key);
}

export async function upsertVaultEntry(input: {
  key: string;
  value: string;
  userId?: string | null;
}) {
  const key = validateVaultKey(input.key);
  const encrypted = encryptValue(input.value);
  const [entry] = await db
    .insert(vaultEntries)
    .values({
      key,
      encryptedValue: encrypted.encryptedValue,
      nonce: encrypted.nonce,
      createdByUserId: input.userId ?? null,
      updatedByUserId: input.userId ?? null,
    })
    .onConflictDoUpdate({
      target: vaultEntries.key,
      set: {
        encryptedValue: encrypted.encryptedValue,
        nonce: encrypted.nonce,
        updatedByUserId: input.userId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({
      key: vaultEntries.key,
      createdAt: vaultEntries.createdAt,
      updatedAt: vaultEntries.updatedAt,
    });

  await auditVault('upsert', key, input.userId);
  return entry;
}

export async function readVaultValue(input: {
  key: string;
  userId?: string | null;
}) {
  const key = validateVaultKey(input.key);
  const [entry] = await db
    .select({
      key: vaultEntries.key,
      encryptedValue: vaultEntries.encryptedValue,
      nonce: vaultEntries.nonce,
      updatedAt: vaultEntries.updatedAt,
    })
    .from(vaultEntries)
    .where(eq(vaultEntries.key, key))
    .limit(1);

  if (!entry) {
    return null;
  }

  const value = decryptValue(entry);
  await auditVault('read', key, input.userId);
  return { key: entry.key, value, updatedAt: entry.updatedAt };
}

/**
 * Delete a vault entry by key. Returns true if a row was deleted, false
 * if the key didn't exist. Used by credential-revocation flows (e.g.
 * disconnecting an MCP OAuth connection) — we delete rather than blank
 * so that the key doesn't show up in listVaultKeyNames() anymore, and
 * the audit log is the only record of the prior credential.
 *
 * The delete and its audit record run inside a single transaction so an
 * audit failure rolls back the deletion — callers never end up with the
 * credential gone but no audit trail.
 */
export async function deleteVaultEntry(input: {
  key: string;
  userId?: string | null;
}): Promise<boolean> {
  const key = validateVaultKey(input.key);
  const deletedKeys = await db.transaction(async (tx) => {
    const result = await tx
      .delete(vaultEntries)
      .where(eq(vaultEntries.key, key))
      .returning({ key: vaultEntries.key });
    await auditVault('delete', key, input.userId, tx);
    return result;
  });
  return deletedKeys.length > 0;
}
