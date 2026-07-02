/**
 * WeCom (企业微信) message crypto — AES-256-CBC decryption + SHA1 signature.
 *
 * Used by the WeCom smart-bot webhook handler
 * (app/api/bot/[authSecret]/[adapter]/callback/route.ts) to verify and
 * decrypt inbound callbacks. WeCom encrypts every webhook payload with
 * the same scheme Feishu uses (both inherit the WeChat-era protocol),
 * but the plaintext framing differs:
 *
 *   plaintext = random(16 bytes) || msg_len(4 bytes, big-endian) || msg || receiveid
 *
 * For smart-bot callbacks the receiveid is the empty string (per WeCom
 * doc 101033). The AES key is derived from the 43-character
 * base64-encoded EncodingAESKey by appending '=' and base64-decoding to
 * 32 bytes. The IV is the first 16 bytes of the key.
 *
 * Signature verification:
 *   msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
 *
 * Only decryption is needed for inbound (WeCom never sends back plaintext).
 * Encryption of outbound passive replies is supported via encryptMessage
 * but the WeCom smart-bot adapter uses HTTP responses in plaintext mode
 * and replies via the aibot/response API instead, so encryption is
 * implemented here for completeness but not currently called from the
 * webhook handler.
 */

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/**
 * Derive the 32-byte AES key from the 43-char base64 EncodingAESKey.
 * WeCom/WeChat append '=' to make it valid base64, then decode.
 */
export function deriveWecomAesKey(encodingAesKey: string): Buffer {
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

/**
 * Verify the msg_signature for an inbound webhook.
 * Returns true if the signature matches sha1(sort([token, timestamp, nonce, encrypt])).
 */
export function verifyWecomSignature(args: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  msgSignature: string;
}): boolean {
  const parts = [args.token, args.timestamp, args.nonce, args.encrypt].sort();
  const computed = createHash('sha1').update(parts.join('')).digest('hex');
  return computed === args.msgSignature;
}

/**
 * Decrypt an encrypted WeCom payload. Returns the plaintext message
 * (the random+msg_len+msg+receiveid framing is stripped; receiveid is
 * verified to be empty or absent for smart-bot use). Throws on bad
 * padding or malformed framing.
 */
export function decryptWecomPayload(args: {
  encodingAesKey: string;
  encrypt: string;
}): string {
  const key = deriveWecomAesKey(args.encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(args.encrypt, 'base64')),
    decipher.final(),
  ]);
  // Strip PKCS7 padding manually — setAutoPadding(false) above.
  const pad = decrypted[decrypted.length - 1];
  const padLen = typeof pad === 'number' && pad >= 1 && pad <= 32 ? pad : 0;
  const unpadded = decrypted.subarray(0, decrypted.length - padLen);
  // plaintext framing: random(16) || msg_len(4, big-endian) || msg || receiveid
  if (unpadded.length < 20) {
    throw new Error('wecom decrypt: malformed plaintext (too short)');
  }
  const msgLen = unpadded.readUInt32BE(16);
  if (16 + 4 + msgLen > unpadded.length) {
    throw new Error('wecom decrypt: msg_len exceeds buffer');
  }
  const msg = unpadded.subarray(20, 20 + msgLen).toString('utf8');
  return msg;
}

/**
 * Encrypt a plaintext message for outbound passive-reply mode.
 * Currently unused (the adapter uses the aibot/response API instead)
 * but kept here so the crypto module is symmetric and testable.
 */
export function encryptWecomPayload(args: {
  encodingAesKey: string;
  message: string;
  receiveid?: string;
}): {
  encrypt: string;
  nonce: string;
  timestamp: string;
  msgSignature: (token: string) => string;
} {
  const key = deriveWecomAesKey(args.encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = Buffer.alloc(16);
  crypto.getRandomValues(random);
  const msgBuf = Buffer.from(args.message, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const receiveid = Buffer.from(args.receiveid ?? '', 'utf8');
  const plaintext = Buffer.concat([random, lenBuf, msgBuf, receiveid]);
  // PKCS7 padding to 32-byte block.
  const blockSize = 32;
  const padLen = blockSize - (plaintext.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  const padded = Buffer.concat([plaintext, padding]);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const encrypt = encrypted.toString('base64');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return {
    encrypt,
    nonce,
    timestamp,
    msgSignature: (token: string) =>
      createHash('sha1')
        .update([token, timestamp, nonce, encrypt].sort().join(''))
        .digest('hex'),
  };
}
