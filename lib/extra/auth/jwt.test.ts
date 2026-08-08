/**
 * Tests for lib/extra/auth/jwt.ts — HMAC-SHA256 JWT implementation.
 *
 * Pure WebCrypto, no DB. Mirrors the lib/auth/session.ts pattern but
 * uses `sub`/`iat`/`exp` field names and takes the secret as an
 * explicit argument instead of reading AUTH_SECRET.
 */

import { describe, expect, it } from 'vitest';
import { createJWT, verifyJWT } from './jwt';
import type { User } from './types';

const SECRET = 'jwt-test-secret';
const USER: User = {
  id: 'user-1',
  username: 'alice',
  roles: [],
  apiKeys: [],
  createdAt: 0,
};

describe('createJWT + verifyJWT round-trip', () => {
  it('round-trips a freshly created token', async () => {
    const token = await createJWT(USER, {
      secret: SECRET,
      expirationSeconds: 60,
    });
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    if (!payload) return; // narrowing
    expect(payload.sub).toBe('user-1');
    expect(payload.username).toBe('alice');
    expect(payload.exp - payload.iat).toBe(60);
  });

  it('produces a two-segment token', async () => {
    const token = await createJWT(USER, {
      secret: SECRET,
      expirationSeconds: 60,
    });
    expect(token.split('.')).toHaveLength(2);
  });
});

describe('verifyJWT rejection paths', () => {
  it('rejects null/undefined input', async () => {
    expect(await verifyJWT(null, SECRET)).toBeNull();
    expect(await verifyJWT(undefined, SECRET)).toBeNull();
    expect(await verifyJWT('', SECRET)).toBeNull();
  });

  it('rejects malformed tokens (wrong segment count)', async () => {
    expect(await verifyJWT('onlyone', SECRET)).toBeNull();
    expect(await verifyJWT('a.b.c', SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createJWT(USER, {
      secret: 'other-secret',
      expirationSeconds: 60,
    });
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    // Create a token with negative expiration so exp is already in the past.
    const token = await createJWT(USER, {
      secret: SECRET,
      expirationSeconds: -10,
    });
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects a payload with wrong field types after valid signature', async () => {
    // Craft a payload whose JSON has non-numeric iat/exp. Signature is
    // valid over the bytes, but decodePayload rejects the shape.
    const badPayload = btoa(
      JSON.stringify({ sub: 'x', username: 'u', iat: 'bad', exp: 'bad' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', SECRET)
      .update(new TextEncoder().encode(badPayload))
      .digest();
    const forgedSig = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyJWT(`${badPayload}.${forgedSig}`, SECRET)).toBeNull();
  });
});
