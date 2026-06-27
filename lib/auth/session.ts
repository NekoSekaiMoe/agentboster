import { readConfiguredAuthSecret } from '@/lib/auth/config';
import { AUTH_COOKIE_NAME, AUTH_TTL_SECONDS } from '@/lib/auth/constants';
import type { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies';

export interface AuthSession {
  userId: string;
  username: string;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readAuthSecret(): string {
  const secret = readConfiguredAuthSecret();
  if (!secret) {
    throw new Error('AUTH_SECRET is required for authentication.');
  }

  return secret;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding =
    normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
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

function encodePayload(payload: AuthSession): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
}

function decodePayload(payload: string): AuthSession | null {
  try {
    const json = decoder.decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json) as Partial<AuthSession>;
    if (
      typeof parsed.username !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }

    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      username: parsed.username,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function createAuthToken(
  userId: string,
  username: string,
): Promise<string> {
  const secret = readAuthSecret();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + AUTH_TTL_SECONDS * 1000;
  const payload = encodePayload({ userId, username, issuedAt, expiresAt });
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifyAuthToken(
  token: string | null | undefined,
): Promise<AuthSession | null> {
  if (!token) {
    return null;
  }

  const secret = readConfiguredAuthSecret();
  if (!secret) {
    return null;
  }

  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length > 0) {
    return null;
  }

  const isValid = await verifySignature(payload, signature, secret);
  if (!isValid) {
    return null;
  }

  const session = decodePayload(payload);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    return null;
  }

  return session;
}

export function getAuthCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  };
}

export function getExpiredAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(0),
  };
}

export async function readAuthSessionFromCookies(
  cookieStore: Pick<RequestCookies, 'get'>,
): Promise<AuthSession | null> {
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  return verifyAuthToken(token);
}

/**
 * Resolve the auth session from a raw Request, accepting either the
 * clawless-auth cookie OR an Authorization: Bearer <token> header. CLI
 * clients use the Bearer form because they don't run in a browser and
 * don't have a cookie jar. Mirrors middleware.ts auth resolution.
 */
export async function readAuthSessionFromRequest(
  request: Request,
): Promise<AuthSession | null> {
  const cookieToken = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))
    ?.slice(AUTH_COOKIE_NAME.length + 1);

  const bearerHeader = request.headers.get('authorization');
  const bearerToken = bearerHeader?.startsWith('Bearer ')
    ? bearerHeader.slice('Bearer '.length)
    : null;

  return verifyAuthToken(cookieToken ?? bearerToken ?? undefined);
}
