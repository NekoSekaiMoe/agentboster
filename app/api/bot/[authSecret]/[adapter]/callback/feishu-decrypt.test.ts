import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * Mirror of decryptFeishuPayload in
 * app/api/bot/[authSecret]/[adapter]/callback/route.ts. Kept in sync
 * manually — the function isn't exported from the route module because
 * Next.js route files don't expose named exports cleanly. If the route
 * changes its decryption, update this mirror.
 *
 * Verified against Feishu's documented v2 event encryption:
 *   key = SHA256(encrypt_key)
 *   blob = base64( iv(16) || AES-256-CBC(plaintext, key, iv) )
 */
function decryptFeishuPayload(
  encryptBlob: string,
  encryptKey: string,
): Record<string, unknown> | null {
  try {
    const key = createHash('sha256').update(encryptKey).digest();
    const blob = Buffer.from(encryptBlob, 'base64');
    if (blob.length < 32) return null;
    const iv = blob.subarray(0, 16);
    const ciphertext = blob.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Encrypt helper that produces a Feishu-shaped payload, for round-trip tests. */
function encryptForFeishu(
  plaintext: Record<string, unknown>,
  encryptKey: string,
): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

describe('decryptFeishuPayload (mirror of route handler logic)', () => {
  it('round-trips a Feishu-shaped encrypted event', () => {
    const key = 'test-encrypt-key-1234';
    const original = {
      schema: '2.0',
      header: {
        event_id: 'evt-1',
        event_type: 'im.message.receive_v1',
        token: 'verif-token-xyz',
      },
      event: { message: { chat_id: 'oc_test' } },
    };
    const blob = encryptForFeishu(original, key);
    const decrypted = decryptFeishuPayload(blob, key);
    expect(decrypted).toEqual(original);
  });

  it('returns null when encrypt_key is wrong (auth failure)', () => {
    const blob = encryptForFeishu({ hi: 1 }, 'correct-key');
    expect(decryptFeishuPayload(blob, 'wrong-key')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(decryptFeishuPayload('!!!not-base64!!!', 'k')).toBeNull();
  });

  it('returns null when blob is shorter than the IV (16 bytes)', () => {
    // base64 of 10 bytes — shorter than the 16-byte IV prefix.
    const short = Buffer.alloc(10, 0x41).toString('base64');
    expect(decryptFeishuPayload(short, 'k')).toBeNull();
  });

  it('returns null for non-JSON plaintext (decryption succeeds but parse fails)', () => {
    const key = 'k';
    const realKey = createHash('sha256').update(key).digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', realKey, iv);
    const encrypted = Buffer.concat([
      cipher.update('not valid json', 'utf8'),
      cipher.final(),
    ]);
    const blob = Buffer.concat([iv, encrypted]).toString('base64');
    expect(decryptFeishuPayload(blob, key)).toBeNull();
  });
});
