/**
 * Tests for lib/security/cron-auth.ts — constant-time CRON_SECRET check
 * with multi-key rotation and the 503-vs-401 distinction.
 *
 * Pure function over process.env + request headers; no DB. The mock
 * pattern (set/restore CRON_SECRET) mirrors l2-link.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCronSecret, hasValidCronSecret } from './cron-auth';

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function req(headers: Record<string, string>): {
  headers: { get: (name: string) => string | null };
} {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

beforeEach(() => {
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe('checkCronSecret', () => {
  it('returns unconfigured when CRON_SECRET is unset (fail closed)', () => {
    const result = checkCronSecret(req({ 'x-api-key': 'anything' }));
    expect(result).toEqual({ valid: false, reason: 'unconfigured' });
  });

  it('returns valid when x-api-key matches', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(checkCronSecret(req({ 'x-api-key': 'the-secret' }))).toEqual({
      valid: true,
    });
  });

  it('returns valid when Authorization Bearer matches', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(
      checkCronSecret(req({ authorization: 'Bearer the-secret' })),
    ).toEqual({ valid: true });
  });

  it('prefers x-api-key over Authorization when both present', () => {
    process.env.CRON_SECRET = 'key-a';
    const result = checkCronSecret(
      req({ 'x-api-key': 'key-a', authorization: 'Bearer key-b' }),
    );
    expect(result).toEqual({ valid: true });
  });

  it('returns missing when neither header is present', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(checkCronSecret(req({}))).toEqual({
      valid: false,
      reason: 'missing',
    });
  });

  it('returns missing when Authorization is not a Bearer header', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(checkCronSecret(req({ authorization: 'Basic abc' }))).toEqual({
      valid: false,
      reason: 'missing',
    });
  });

  it('returns invalid when the secret is wrong', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(checkCronSecret(req({ 'x-api-key': 'wrong' }))).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('matches any comma-separated candidate (key rotation)', () => {
    process.env.CRON_SECRET = 'old-key, new-key ,yet-another';
    expect(checkCronSecret(req({ 'x-api-key': 'new-key' }))).toEqual({
      valid: true,
    });
    expect(checkCronSecret(req({ 'x-api-key': 'old-key' }))).toEqual({
      valid: true,
    });
    expect(checkCronSecret(req({ 'x-api-key': 'yet-another' }))).toEqual({
      valid: true,
    });
  });

  it('ignores empty comma-separated entries', () => {
    process.env.CRON_SECRET = ',,real-key,,';
    expect(checkCronSecret(req({ 'x-api-key': 'real-key' }))).toEqual({
      valid: true,
    });
    expect(checkCronSecret(req({ 'x-api-key': '' }))).not.toEqual({
      valid: true,
    });
  });
});

describe('hasValidCronSecret (boolean back-compat)', () => {
  it('returns true only for a valid secret', () => {
    process.env.CRON_SECRET = 'the-secret';
    expect(hasValidCronSecret(req({ 'x-api-key': 'the-secret' }))).toBe(true);
    expect(hasValidCronSecret(req({ 'x-api-key': 'wrong' }))).toBe(false);
  });

  it('returns false when unconfigured (does not distinguish 503)', () => {
    expect(hasValidCronSecret(req({ 'x-api-key': 'x' }))).toBe(false);
  });
});
