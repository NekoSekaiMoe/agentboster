import type { TokenPayload, User } from './types';

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding =
    normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifySignature(
  value: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(base64UrlToBytes(signature)),
    encoder.encode(value),
  );
}

function encodePayload(payload: TokenPayload): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
}

function decodePayload(payload: string): TokenPayload | null {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json) as Partial<TokenPayload>;
    if (
      typeof parsed.sub !== 'string' ||
      typeof parsed.username !== 'string' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    return {
      sub: parsed.sub,
      username: parsed.username,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export interface JWTOptions {
  secret: string;
  expirationSeconds: number;
}

export async function createJWT(
  user: User,
  options: JWTOptions,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + options.expirationSeconds;
  const payload: TokenPayload = {
    sub: user.id,
    username: user.username,
    iat,
    exp,
  };
  const encoded = encodePayload(payload);
  const sig = await sign(encoded, options.secret);
  return `${encoded}.${sig}`;
}

export async function verifyJWT(
  token: string | null | undefined,
  secret: string,
): Promise<TokenPayload | null> {
  if (!token) return null;

  const [encoded, signature, ...rest] = token.split('.');
  if (!encoded || !signature || rest.length > 0) return null;

  const isValid = await verifySignature(encoded, signature, secret);
  if (!isValid) return null;

  const payload = decodePayload(encoded);
  if (!payload) return null;

  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}
