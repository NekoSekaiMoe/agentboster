/**
 * Contract tests for the Postgres KV backend's value-serialization and TTL
 * logic. These are the parts that must byte-for-byte mirror Upstash's
 * behavior; the drizzle query construction is exercised by integration, not
 * here (mocking the drizzle chain would only test the mock).
 *
 * Run via: yarn test lib/core/kv/pg-backend.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  expiryFromOptions,
  parseStoredValue,
  serializeValue,
} from './pg-backend';

describe('serializeValue / parseStoredValue (Upstash round-trip)', () => {
  it('stores plain strings verbatim (lock tokens, ids, base64)', () => {
    // A bare token is NOT valid JSON — it must round-trip as the raw string,
    // exactly like Upstash returns it.
    const token = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const stored = serializeValue(token);
    expect(stored).toBe(token);
    expect(parseStoredValue(stored)).toBe(token);
  });

  it('stores the "1" dedup marker as the string "1"', () => {
    const stored = serializeValue('1');
    expect(stored).toBe('1');
    // Note: '1' IS valid JSON and parses to the number 1. This mirrors
    // Upstash's auto-parse; every dedup caller only checks truthiness / 'OK'
    // on the SET result, never re-reads the value as a string.
    expect(parseStoredValue(stored)).toBe(1);
  });

  it("round-trips a JSON.stringify'd object back to an object (config.ts)", () => {
    const config = { models: { default: 'claude-opus-4-8' }, nested: { a: 1 } };
    // Callers JSON.stringify before set(); serializeValue keeps the string.
    const stored = serializeValue(JSON.stringify(config));
    expect(typeof stored).toBe('string');
    expect(parseStoredValue(stored)).toEqual(config);
  });

  it('serializes a non-string value by JSON-encoding it', () => {
    expect(serializeValue({ a: 1 })).toBe('{"a":1}');
    expect(parseStoredValue(serializeValue({ a: 1 }))).toEqual({ a: 1 });
  });

  it('falls back to the raw string on unparseable input', () => {
    expect(parseStoredValue('not{valid}json')).toBe('not{valid}json');
  });
});

describe('expiryFromOptions', () => {
  it('returns null when no expiry option is given', () => {
    expect(expiryFromOptions(undefined)).toBeNull();
    expect(expiryFromOptions({})).toBeNull();
    expect(expiryFromOptions({ nx: true })).toBeNull();
  });

  it('computes px (milliseconds) into an absolute future Date', () => {
    const before = Date.now();
    const d = expiryFromOptions({ px: 30_000 });
    expect(d).toBeInstanceOf(Date);
    const delta = (d as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(30_000);
    expect(delta).toBeLessThan(31_000);
  });

  it('computes ex (seconds) into an absolute future Date', () => {
    const before = Date.now();
    const d = expiryFromOptions({ ex: 60 });
    const delta = (d as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(60_000);
    expect(delta).toBeLessThan(61_000);
  });

  it('prefers px over ex when both are present', () => {
    const before = Date.now();
    const d = expiryFromOptions({ ex: 3600, px: 5_000 });
    const delta = (d as Date).getTime() - before;
    // px (5s) wins, not ex (3600s).
    expect(delta).toBeLessThan(6_000);
  });
});
