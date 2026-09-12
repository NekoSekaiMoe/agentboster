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
