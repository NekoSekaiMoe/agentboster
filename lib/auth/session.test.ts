/**
 * Tests for the self-implemented auth token protocol.
 *
 * lib/auth/session.ts implements a JWT-like HMAC-SHA256 token format
 * (`<base64url(payload)>.<base64url(hmac)>`) used for browser cookie
 * sessions and CLI Bearer auth. This is the single most security-
 * critical primitive in the web app and had zero tests. The mock
 * pattern (set/restore AUTH_SECRET) is borrowed from
 * lib/security/l2-link.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAuthToken,
  getAuthCookieOptions,
  getExpiredAuthCookieOptions,
  readAuthSessionFromCookies,
  readAuthSessionFromRequest,
  verifyAuthToken,
} from './session';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod';
});

afterEach(() => {
  const env = process.env as Record<string, string | undefined>;
  if (ORIGINAL_AUTH_SECRET === undefined) {
    delete env.AUTH_SECRET;
  } else {
    env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe('createAuthToken + verifyAuthToken round-trip', () => {
  it('round-trips a freshly created token', async () => {
    const token = await createAuthToken('user-1', 'alice');
    const session = await verifyAuthToken(token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe('user-1');
    expect(session?.username).toBe('alice');
    expect(session?.jti).toBeUndefined();
    expect(typeof session?.issuedAt).toBe('number');
    expect(typeof session?.expiresAt).toBe('number');
    expect(session?.expiresAt).toBeGreaterThan(session?.issuedAt ?? 0);
  });

  it('embeds the optional jti (CLI device id) when provided', async () => {
    const token = await createAuthToken('user-1', 'alice', {
      jti: 'device-abc',
    });
    const session = await verifyAuthToken(token);
    expect(session?.jti).toBe('device-abc');
  });

  it('produces a two-segment payload.signature token', async () => {
    const token = await createAuthToken('user-1', 'alice');
    expect(token.split('.')).toHaveLength(2);
  });
});

describe('verifyAuthToken rejection paths', () => {
  it('rejects null/undefined/empty input', async () => {
    expect(await verifyAuthToken(null)).toBeNull();
    expect(await verifyAuthToken(undefined)).toBeNull();
    expect(await verifyAuthToken('')).toBeNull();
  });

  it('rejects when AUTH_SECRET is not configured', async () => {
    delete process.env.AUTH_SECRET;
    const token = await (async () => {
      process.env.AUTH_SECRET = 'tmp';
      const t = await createAuthToken('u', 'a');
      delete process.env.AUTH_SECRET;
      return t;
    })();
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('rejects malformed tokens (wrong segment count)', async () => {
    expect(await verifyAuthToken('onlyone')).toBeNull();
    expect(await verifyAuthToken('a.b.c')).toBeNull();
    expect(await verifyAuthToken('a.b.c.d')).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    process.env.AUTH_SECRET = 'secret-a';
    const token = await createAuthToken('u', 'a');
    process.env.AUTH_SECRET = 'secret-b';
    expect(await verifyAuthToken(token)).toBeNull();
  });

  it('rejects a token whose payload was tampered with', async () => {
    const token = await createAuthToken('user-1', 'alice');
    const [payload, signature] = token.split('.');
    // Flip the userId by editing the base64url payload directly. The
    // signature no longer matches → verification must fail.
    const tamperedPayload = `${payload.slice(0, -2)}XX`;
    expect(await verifyAuthToken(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    // Create a token, then rewind expiresAt by forging the payload with
    // a past timestamp while re-signing with the correct secret. This
    // isolates the expiry check from the signature check.
    process.env.AUTH_SECRET = 'exp-secret';
    // Build a payload whose expiresAt is already in the past.
    const past = Date.now() - 10_000;
    // Reuse createAuthToken then decode/re-encode is complex; instead,
    // craft a minimal expired token via the internal encode path by
    // importing the encoder indirectly: construct from a known-good
    // token and swap its payload's expiresAt through JSON edit.
    const good = await createAuthToken('u', 'a');
    const [payload] = good.split('.');
    // Decode payload (base64url JSON), patch expiresAt, re-encode.
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0),
        ),
      ),
    ) as { expiresAt: number };
    json.expiresAt = past;
    const forgedJson = JSON.stringify(json);
    const forgedPayload = btoa(forgedJson)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // Re-sign with the correct secret so only the expiry check fails.
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'exp-secret')
      .update(new TextEncoder().encode(forgedPayload))
      .digest();
    const forgedSig = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyAuthToken(`${forgedPayload}.${forgedSig}`)).toBeNull();
  });

  it('rejects a payload that decodes to non-numeric expiresAt', async () => {
    // Craft a token whose payload JSON has wrong field types; the
    // signature is valid over the payload bytes, but decodePayload
    // rejects the shape.
    process.env.AUTH_SECRET = 'shape-secret';
    const badPayload = btoa(
      JSON.stringify({ username: 'a', issuedAt: 'x', expiresAt: 'y' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', 'shape-secret')
      .update(new TextEncoder().encode(badPayload))
      .digest();
    const forgedSig = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyAuthToken(`${badPayload}.${forgedSig}`)).toBeNull();
  });
});

describe('cookie options', () => {
  it('getAuthCookieOptions reflects expiresAt and is httpOnly', () => {
    const expiresAt = Date.now() + 60_000;
    const opts = getAuthCookieOptions(expiresAt);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.expires).toEqual(new Date(expiresAt));
  });

  it('getAuthCookieOptions is secure in production', () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(getAuthCookieOptions(Date.now()).secure).toBe(true);
  });

  it('getAuthCookieOptions is not secure outside production', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    expect(getAuthCookieOptions(Date.now()).secure).toBe(false);
  });

  it('getExpiredAuthCookieOptions sets epoch (immediate expiry)', () => {
    const opts = getExpiredAuthCookieOptions();
    expect(opts.expires).toEqual(new Date(0));
    expect(opts.httpOnly).toBe(true);
  });
});

describe('readAuthSessionFromCookies / readAuthSessionFromRequest', () => {
  it('reads a valid token from a cookie store', async () => {
    const token = await createAuthToken('user-9', 'bob');
    const session = await readAuthSessionFromCookies({
      get: (name: string) =>
        name === 'clawless-auth' ? { name, value: token } : undefined,
    });
    expect(session?.userId).toBe('user-9');
  });

  it('returns null when the cookie is absent', async () => {
    const session = await readAuthSessionFromCookies({
      get: () => undefined,
    });
    expect(session).toBeNull();
  });

  it('reads a Bearer token from a Request', async () => {
    const token = await createAuthToken('user-9', 'bob');
    const req = new Request('https://x.test/api', {
      headers: { authorization: `Bearer ${token}` },
    });
    const session = await readAuthSessionFromRequest(req);
    expect(session?.userId).toBe('user-9');
  });

  it('reads a cookie token from a Request', async () => {
    const token = await createAuthToken('user-9', 'bob');
    const req = new Request('https://x.test/api', {
      headers: { cookie: `clawless-auth=${token}` },
    });
    const session = await readAuthSessionFromRequest(req);
    expect(session?.userId).toBe('user-9');
  });

  it('prefers cookie over Bearer when both are present (cookieToken ?? bearerToken)', async () => {
    const cookieToken = await createAuthToken('cookie-user', 'c');
    const bearerToken = await createAuthToken('bearer-user', 'b');
    const req = new Request('https://x.test/api', {
      headers: {
        cookie: `clawless-auth=${cookieToken}`,
        authorization: `Bearer ${bearerToken}`,
      },
    });
    const session = await readAuthSessionFromRequest(req);
    expect(session?.userId).toBe('cookie-user');
  });

  it('returns null when neither cookie nor Bearer is present', async () => {
    const session = await readAuthSessionFromRequest(
      new Request('https://x.test/api'),
    );
    expect(session).toBeNull();
  });
});
