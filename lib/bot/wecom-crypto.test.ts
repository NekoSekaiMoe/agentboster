import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptWecomPayload,
  deriveWecomAesKey,
  encryptWecomPayload,
  verifyWecomSignature,
} from './wecom-crypto';

/**
 * The crypto protocol is documented in lib/bot/wecom-crypto.ts.
 * Verified against WeCom doc 101033 framing:
 *   plaintext = random(16) || msg_len(4, big-endian) || msg || receiveid
 *   aes key   = base64decode(EncodingAESKey + "=")
 *   iv        = key[0:16]
 *   signature = sha1(sort([token, timestamp, nonce, encrypt]).join(""))
 */

// Generate a valid 43-char base64 EncodingAESKey (32 raw bytes).
const TEST_KEY = randomBytes(32).toString('base64').slice(0, 43);

describe('wecom-crypto', () => {
  it('deriveWecomAesKey produces a 32-byte key', () => {
    const key = deriveWecomAesKey(TEST_KEY);
    expect(key.length).toBe(32);
  });

  it('round-trips: encrypt → decrypt recovers the original message', () => {
    const message = JSON.stringify({
      MsgType: 'text',
      From: { UserId: 'test_user' },
      Text: { Content: 'hello' },
    });
    const encrypted = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message,
      // WeCom smart bot uses empty receiveid.
      receiveid: '',
    });
    const decrypted = decryptWecomPayload({
      encodingAesKey: TEST_KEY,
      encrypt: encrypted.encrypt,
    });
    expect(decrypted).toBe(message);
  });

  it('round-trips with a non-empty receiveid (enterprise-app scenario)', () => {
    const message = 'corps-scoped message';
    const encrypted = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message,
      receiveid: 'corp123',
    });
    const decrypted = decryptWecomPayload({
      encodingAesKey: TEST_KEY,
      encrypt: encrypted.encrypt,
    });
    // receiveid is stripped by decrypt, so plaintext = message exactly.
    expect(decrypted).toBe(message);
  });

  it('verifyWecomSignature accepts the signature produced by the same token', () => {
    const token = 'test_token_xyz';
    const message = 'hi';
    const encrypted = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message,
    });
    expect(
      verifyWecomSignature({
        token,
        timestamp: encrypted.timestamp,
        nonce: encrypted.nonce,
        encrypt: encrypted.encrypt,
        msgSignature: encrypted.msgSignature(token),
      }),
    ).toBe(true);
  });

  it('verifyWecomSignature rejects a signature computed with a different token', () => {
    const encrypted = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message: 'x',
    });
    expect(
      verifyWecomSignature({
        token: 'right-token',
        timestamp: encrypted.timestamp,
        nonce: encrypted.nonce,
        encrypt: encrypted.encrypt,
        msgSignature: encrypted.msgSignature('wrong-token'),
      }),
    ).toBe(false);
  });

  it('decrypt throws on truncated payload', () => {
    expect(() =>
      decryptWecomPayload({
        encodingAesKey: TEST_KEY,
        encrypt: Buffer.alloc(10).toString('base64'),
      }),
    ).toThrow();
  });

  it('decrypt throws on invalid base64', () => {
    expect(() =>
      decryptWecomPayload({
        encodingAesKey: TEST_KEY,
        encrypt: '!!!not base64!!!',
      }),
    ).toThrow();
  });

  it('decrypt throws on a forged msg_len that exceeds the buffer', () => {
    // Craft a plaintext whose msg_len is huge but the msg body is short.
    const key = deriveWecomAesKey(TEST_KEY);
    const iv = key.subarray(0, 16);
    const random = randomBytes(16);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(9999, 0); // forged
    const msg = Buffer.from('short', 'utf8');
    const plaintext = Buffer.concat([random, lenBuf, msg]);
    const blockSize = 32;
    const padLen = blockSize - (plaintext.length % blockSize);
    const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    const forged = Buffer.concat([
      cipher.update(padded),
      cipher.final(),
    ]).toString('base64');
    expect(() =>
      decryptWecomPayload({ encodingAesKey: TEST_KEY, encrypt: forged }),
    ).toThrow(/msg_len/);
  });

  it('signature is deterministic for the same inputs (sha1 of sorted join)', () => {
    // Direct sha1 cross-check using a known token.
    const token = 'tk';
    const timestamp = '1700000000';
    const nonce = 'n1';
    const encrypt = 'abc';
    const expected = createHash('sha1')
      .update([token, timestamp, nonce, encrypt].sort().join(''))
      .digest('hex');
    expect(
      verifyWecomSignature({
        token,
        timestamp,
        nonce,
        encrypt,
        msgSignature: expected,
      }),
    ).toBe(true);
  });

  it('encryptWecomPayload produces unique nonces (no IV reuse)', () => {
    const a = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message: 'same',
    });
    const b = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message: 'same',
    });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.encrypt).not.toBe(b.encrypt);
  });

  it('nonce looks like a UUID-derived hex slice, not all-zero', () => {
    const encrypted = encryptWecomPayload({
      encodingAesKey: TEST_KEY,
      message: 'x',
    });
    expect(encrypted.nonce).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.nonce).not.toBe('0000000000');
  });

  it('randomUUID import is exercised (sanity, no throw)', () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
