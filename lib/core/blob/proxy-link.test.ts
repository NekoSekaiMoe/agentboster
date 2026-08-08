/**
 * Tests for lib/core/blob/proxy-link.ts — HMAC-signed blob proxy URLs.
 *
 * Self-hosted S3/MinIO replacement for Vercel Blob URLs. Same shape as
 * lib/security/l2-link.ts (HMAC over `<path>:<expires>`). The mock
 * pattern (set/restore AUTH_SECRET) mirrors l2-link.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOB_LINK_TTL_SECONDS,
  signBlobUrl,
  verifyBlobUrl,
} from './proxy-link';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = 'blob-test-secret';
});

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  }
});

describe('DEFAULT_BLOB_LINK_TTL_SECONDS', () => {
  it('is 30 days', () => {
    expect(DEFAULT_BLOB_LINK_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });
});

describe('signBlobUrl + verifyBlobUrl round-trip', () => {
  it('round-trips a signed URL for a plain path', async () => {
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'sessions/s1/file.txt',
    });
    expect(url).toMatch(
      /^https:\/\/app\.test\/api\/blob\/sessions\/s1\/file\.txt\?t=\d+&s=[0-9a-f]+$/,
    );
    const result = await verifyBlobUrl({
      blobPath: 'sessions/s1/file.txt',
      expiresParam: new URL(url).searchParams.get('t'),
      signatureParam: new URL(url).searchParams.get('s'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('encodes special characters in path segments but preserves slashes', async () => {
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'sessions/s 1/fi#e.txt',
    });
    // The space and # in the segment must be percent-encoded, but the
    // slashes between segments stay literal so the [...path] catch-all
    // can reconstruct the key.
    expect(url).toContain('/api/blob/sessions/s%201/fi%23e.txt');
    const result = await verifyBlobUrl({
      blobPath: 'sessions/s 1/fi#e.txt',
      expiresParam: new URL(url).searchParams.get('t'),
      signatureParam: new URL(url).searchParams.get('s'),
    });
    expect(result.ok).toBe(true);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const url = await signBlobUrl({
      baseUrl: 'https://app.test///',
      blobPath: 'a/b',
    });
    expect(url.startsWith('https://app.test/api/blob/')).toBe(true);
  });

  it('honors a custom ttl', async () => {
    const before = Math.floor(Date.now() / 1000);
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'a',
      ttlSeconds: 60,
    });
    const expires = Number(new URL(url).searchParams.get('t'));
    expect(expires - before).toBeGreaterThanOrEqual(59);
    expect(expires - before).toBeLessThanOrEqual(61);
  });

  it('falls back to default ttl when ttl is non-positive', async () => {
    const before = Math.floor(Date.now() / 1000);
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'a',
      ttlSeconds: 0,
    });
    const expires = Number(new URL(url).searchParams.get('t'));
    expect(expires - before).toBe(DEFAULT_BLOB_LINK_TTL_SECONDS);
  });
});

describe('verifyBlobUrl rejection paths', () => {
  it('returns missing when params are absent', async () => {
    const result = await verifyBlobUrl({
      blobPath: 'a',
      expiresParam: null,
      signatureParam: null,
    });
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('returns invalid when expires is not a finite positive number', async () => {
    const result = await verifyBlobUrl({
      blobPath: 'a',
      expiresParam: 'not-a-number',
      signatureParam: 'deadbeef',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns expired for a past expires', async () => {
    const result = await verifyBlobUrl({
      blobPath: 'a',
      expiresParam: '1',
      signatureParam: 'deadbeef',
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('returns invalid when the signature does not match', async () => {
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'a',
    });
    const result = await verifyBlobUrl({
      blobPath: 'a',
      expiresParam: new URL(url).searchParams.get('t'),
      signatureParam: 'a'.repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns invalid when the blobPath differs (signature bound to path)', async () => {
    const url = await signBlobUrl({
      baseUrl: 'https://app.test',
      blobPath: 'original',
    });
    const result = await verifyBlobUrl({
      blobPath: 'tampered',
      expiresParam: new URL(url).searchParams.get('t'),
      signatureParam: new URL(url).searchParams.get('s'),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});
