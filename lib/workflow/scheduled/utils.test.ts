/**
 * Tests for the scheduled-task date/time helpers.
 *
 * Pure functions over Intl + Date arithmetic (no DB, no network, no
 * timers). The scheduling helpers are the highest-regression-risk module
 * here: DST transitions, "time already passed → push to tomorrow", the
 * 3-day max-delay ceiling, and HH:mm parsing all have sharp edges.
 *
 * All "now" values are injected via the `now` option so results are
 * deterministic regardless of when the suite runs. Timezones used in
 * assertions are chosen for stable, well-known UTC offsets (UTC itself,
 * Asia/Shanghai = UTC+8 no DST, America/New_York has DST but stable in
 * the windows we pick).
 */

import { describe, expect, it } from 'vitest';
import {
  computeNextDailyRunAt,
  getDefaultScheduleTimezone,
  parseDailyTime,
  parseDelayTarget,
  sameInstant,
  validateTimezone,
} from './utils';

describe('getDefaultScheduleTimezone', () => {
  it('is Asia/Shanghai', () => {
    expect(getDefaultScheduleTimezone()).toBe('Asia/Shanghai');
  });
});

describe('validateTimezone', () => {
  it('returns the input for a valid IANA timezone', () => {
    expect(validateTimezone('UTC')).toBe('UTC');
    expect(validateTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(validateTimezone('America/New_York')).toBe('America/New_York');
  });

  it('throws for an invalid timezone', () => {
    expect(() => validateTimezone('Not/A/Zone')).toThrow(/Invalid timezone/);
    expect(() => validateTimezone('Mars/Olympus')).toThrow(/Invalid timezone/);
  });
});

describe('parseDailyTime', () => {
  it('parses HH:mm', () => {
    expect(parseDailyTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseDailyTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseDailyTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseDailyTime('  08:05  ')).toEqual({ hour: 8, minute: 5 });
  });

  it('accepts single-digit hour (H:mm)', () => {
    expect(parseDailyTime('8:05')).toEqual({ hour: 8, minute: 5 });
  });

  it('rejects hour >= 24', () => {
    expect(() => parseDailyTime('24:00')).toThrow(/HH:mm/);
  });

  it('rejects minute >= 60', () => {
    expect(() => parseDailyTime('10:60')).toThrow(/HH:mm/);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '10', '10:', ':30', '10:30:45', '25:99']) {
      expect(() => parseDailyTime(bad)).toThrow(/HH:mm/);
    }
  });
});

describe('parseDelayTarget', () => {
  it('computes now + delaySeconds when delaySeconds is provided', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const target = parseDelayTarget({ delaySeconds: 60, now });
    expect(target).toEqual(new Date('2025-01-01T00:01:00Z'));
  });

  it('accepts an ISO runAt in the future', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const target = parseDelayTarget({
      runAt: '2025-01-01T01:00:00Z',
      now,
    });
    expect(target).toEqual(new Date('2025-01-01T01:00:00Z'));
  });

  it('rejects delaySeconds <= 0', () => {
    expect(() =>
      parseDelayTarget({ delaySeconds: 0, now: new Date() }),
    ).toThrow(/positive/);
    expect(() =>
      parseDelayTarget({ delaySeconds: -5, now: new Date() }),
    ).toThrow(/positive/);
  });

  it('rejects NaN / non-finite delaySeconds', () => {
    expect(() =>
      parseDelayTarget({ delaySeconds: Number.NaN, now: new Date() }),
    ).toThrow(/positive/);
    expect(() =>
      parseDelayTarget({
        delaySeconds: Number.POSITIVE_INFINITY,
        now: new Date(),
      }),
    ).toThrow(/positive/);
  });

  it('rejects delaySeconds over 3 days', () => {
    expect(() =>
      parseDelayTarget({ delaySeconds: 3 * 24 * 60 * 60 + 1, now: new Date() }),
    ).toThrow(/3 days/);
  });

  it('accepts delaySeconds of exactly 3 days (boundary)', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const target = parseDelayTarget({
      delaySeconds: 3 * 24 * 60 * 60,
      now,
    });
    expect(target).toEqual(new Date('2025-01-04T00:00:00Z'));
  });

  it('rejects runAt in the past', () => {
    const now = new Date('2025-01-02T00:00:00Z');
    expect(() =>
      parseDelayTarget({ runAt: '2025-01-01T00:00:00Z', now }),
    ).toThrow(/future/);
  });

  it('rejects runAt beyond 3 days from now', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    expect(() =>
      parseDelayTarget({ runAt: '2025-01-05T00:00:01Z', now }),
    ).toThrow(/3 days/);
  });

  it('rejects malformed runAt', () => {
    expect(() =>
      parseDelayTarget({ runAt: 'not-a-date', now: new Date() }),
    ).toThrow(/ISO/);
  });

  it('throws when neither runAt nor delaySeconds is provided', () => {
    expect(() => parseDelayTarget({ now: new Date() })).toThrow(
      /runAt or delaySeconds/,
    );
  });
});

describe('computeNextDailyRunAt', () => {
  it('picks today when the target time is still ahead in the day', () => {
    // 2025-01-15 is a Wednesday, no DST in either zone we use.
    const now = new Date('2025-01-15T08:00:00Z'); // 16:00 in Shanghai
    const next = computeNextDailyRunAt({
      dailyTime: '20:00', // 20:00 Shanghai = 12:00 UTC, still ahead of 08:00 UTC
      timeZone: 'Asia/Shanghai',
      now,
    });
    expect(next.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  it('pushes to the next day when the target time already passed today', () => {
    const now = new Date('2025-01-15T13:00:00Z'); // 21:00 Shanghai
    const next = computeNextDailyRunAt({
      dailyTime: '20:00', // 20:00 Shanghai = 12:00 UTC, already passed
      timeZone: 'Asia/Shanghai',
      now,
    });
    // Next occurrence: 2025-01-16 20:00 Shanghai = 12:00 UTC
    expect(next.toISOString()).toBe('2025-01-16T12:00:00.000Z');
  });

  it('defaults timezone to Asia/Shanghai when omitted', () => {
    const now = new Date('2025-01-15T08:00:00Z'); // 16:00 default TZ
    const withDefault = computeNextDailyRunAt({
      dailyTime: '20:00',
      now,
    });
    const explicit = computeNextDailyRunAt({
      dailyTime: '20:00',
      timeZone: 'Asia/Shanghai',
      now,
    });
    expect(withDefault.getTime()).toBe(explicit.getTime());
  });

  it('honors a UTC timezone', () => {
    const now = new Date('2025-01-15T05:00:00Z');
    const next = computeNextDailyRunAt({
      dailyTime: '10:00',
      timeZone: 'UTC',
      now,
    });
    expect(next.toISOString()).toBe('2025-01-15T10:00:00.000Z');
  });

  it('rolls across a month boundary (Jan 31 → Feb 1)', () => {
    // 2025-01-31 23:00 UTC = next day in Shanghai is Feb 1.
    const now = new Date('2025-01-31T15:30:00Z'); // 23:30 Shanghai, past 20:00
    const next = computeNextDailyRunAt({
      dailyTime: '20:00',
      timeZone: 'Asia/Shanghai',
      now,
    });
    // 2025-02-01 20:00 Shanghai = 12:00 UTC
    expect(next.toISOString()).toBe('2025-02-01T12:00:00.000Z');
  });
});

describe('sameInstant', () => {
  it('is true for equal timestamps', () => {
    const a = new Date('2025-01-01T00:00:00Z');
    const b = new Date('2025-01-01T00:00:00Z');
    expect(sameInstant(a, b)).toBe(true);
  });

  it('is false for different timestamps', () => {
    expect(
      sameInstant(
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-01-01T00:00:01Z'),
      ),
    ).toBe(false);
  });

  it('is false when either side is null', () => {
    const a = new Date('2025-01-01T00:00:00Z');
    expect(sameInstant(a, null)).toBe(false);
    expect(sameInstant(null, a)).toBe(false);
    expect(sameInstant(null, null)).toBe(false);
  });
});
