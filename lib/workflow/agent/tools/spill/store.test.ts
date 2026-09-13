import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvGetMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/core/kv', () => ({
  get: kvGetMock,
  set: vi.fn(),
}));

import { getSpill } from './store';
import type { StoredSpill } from './core';

function record(overrides: Partial<StoredSpill> = {}): StoredSpill {
  return {
    text: 'abcdef',
    totalChars: 6,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getSpill ownership binding', () => {
  beforeEach(() => {
    kvGetMock.mockReset();
  });

  it('returns the record when the session matches', async () => {
    kvGetMock.mockResolvedValue(record({ sessionId: 'sess-1' }));
    await expect(getSpill('call-1', 'sess-1')).resolves.toMatchObject({
      text: 'abcdef',
      sessionId: 'sess-1',
    });
  });

  it('fails closed on a session mismatch (indistinguishable from missing)', async () => {
    kvGetMock.mockResolvedValue(record({ sessionId: 'sess-other' }));
    await expect(getSpill('call-1', 'sess-1')).resolves.toBeNull();
  });

  it('fails closed on records predating ownership binding', async () => {
    kvGetMock.mockResolvedValue(record());
    await expect(getSpill('call-1', 'sess-1')).resolves.toBeNull();
  });

  it('does not enforce ownership when no expected session is given', async () => {
    kvGetMock.mockResolvedValue(record());
    await expect(getSpill('call-1')).resolves.toMatchObject({ text: 'abcdef' });
  });

  it('returns null for missing or malformed values', async () => {
    kvGetMock.mockResolvedValue(undefined);
    await expect(getSpill('call-x', 'sess-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue('not-an-object');
    await expect(getSpill('call-x', 'sess-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue({ totalChars: 3 });
    await expect(getSpill('call-x', 'sess-1')).resolves.toBeNull();
  });
});

describe('getSpill totalChars integrity', () => {
  beforeEach(() => {
    kvGetMock.mockReset();
  });

  it('accepts a valid record with totalChars larger than the stored prefix', async () => {
    kvGetMock.mockResolvedValue(
      record({ text: 'abcdef', totalChars: 600_000 }),
    );
    await expect(getSpill('call-1')).resolves.toMatchObject({
      text: 'abcdef',
      totalChars: 600_000,
    });
  });

  it('returns null when totalChars is missing', async () => {
    const { totalChars: _drop, ...withoutTotal } = record();
    kvGetMock.mockResolvedValue(withoutTotal);
    await expect(getSpill('call-1')).resolves.toBeNull();
  });

  it('returns null when totalChars is not a safe integer', async () => {
    kvGetMock.mockResolvedValue(record({ totalChars: 1.5 }));
    await expect(getSpill('call-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue(record({ totalChars: Number.NaN }));
    await expect(getSpill('call-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue(
      record({ totalChars: Number.MAX_SAFE_INTEGER + 1 }),
    );
    await expect(getSpill('call-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue(
      record({ totalChars: '6' as unknown as number }),
    );
    await expect(getSpill('call-1')).resolves.toBeNull();
  });

  it('returns null when totalChars is smaller than the stored text', async () => {
    // Also covers negative values — anything below text.length is invalid.
    kvGetMock.mockResolvedValue(record({ totalChars: 3 }));
    await expect(getSpill('call-1')).resolves.toBeNull();
    kvGetMock.mockResolvedValue(record({ totalChars: -1 }));
    await expect(getSpill('call-1')).resolves.toBeNull();
  });
});
