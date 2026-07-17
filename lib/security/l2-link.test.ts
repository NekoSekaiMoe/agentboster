import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_L2_LINK_TTL_SECONDS,
  signL2Link,
  verifyL2Link,
} from './l2-link';

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod';
});

afterEach(() => {
  if (ORIGINAL_AUTH_SECRET === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  }
});

describe('signL2Link / verifyL2Link', () => {
  it('round-trips a valid link', async () => {
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    const result = await verifyL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
      expiresParam: String(signed.expires),
      signatureParam: signed.signature,
    });
    expect(result.ok).toBe(true);
  });

  it('produces URL-safe params containing t and s', async () => {
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    expect(signed.params).toMatch(/^t=\d+&s=[0-9a-f]+$/);
  });

  it('uses the default TTL of 1 hour when not overridden', async () => {
    const before = Math.floor(Date.now() / 1000);
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    expect(signed.expires - before).toBe(DEFAULT_L2_LINK_TTL_SECONDS);
  });

  it('honors a custom TTL', async () => {
    const signed = await signL2Link({
      decisionId: 'd',
      action: 'a',
      ttlSeconds: 60,
    });
    expect(signed.params.startsWith('t=')).toBe(true);
    // Verify still succeeds (60s is in the future).
    const result = await verifyL2Link({
      decisionId: 'd',
      action: 'a',
      expiresParam: String(signed.expires),
      signatureParam: signed.signature,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered action (signature is action-bound)', async () => {
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    const result = await verifyL2Link({
      decisionId: 'dec_abc',
      action: 'reject_once',
      expiresParam: String(signed.expires),
      signatureParam: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects a tampered decisionId', async () => {
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    const result = await verifyL2Link({
      decisionId: 'dec_other',
      action: 'pass_once',
      expiresParam: String(signed.expires),
      signatureParam: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects an expired link', async () => {
    // Build a signature for a timestamp in the past directly (signL2Link
    // rejects non-positive TTLs by falling back to the default).
    const pastExpires = Math.floor(Date.now() / 1000) - 3600;
    const signature = createHmac('sha256', 'test-secret-do-not-use-in-prod')
      .update(`dec_abc:pass_once:${pastExpires}`)
      .digest('hex');
    const result = await verifyL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
      expiresParam: String(pastExpires),
      signatureParam: signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects missing params', async () => {
    const result = await verifyL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
      expiresParam: null,
      signatureParam: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing');
  });

  it('rejects a signature signed with a different AUTH_SECRET', async () => {
    const signed = await signL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
    });
    process.env.AUTH_SECRET = 'a-different-secret';
    const result = await verifyL2Link({
      decisionId: 'dec_abc',
      action: 'pass_once',
      expiresParam: String(signed.expires),
      signatureParam: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('throws a clear error when AUTH_SECRET is unset during signing', async () => {
    delete process.env.AUTH_SECRET;
    await expect(() =>
      signL2Link({ decisionId: 'd', action: 'a' }),
    ).rejects.toThrowError(/AUTH_SECRET/);
  });
});
