import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the KV layer so cache tests never touch a real backend. The factory's
// get/set are bare vi.fn() instances; we cast via vi.mocked() at call sites,
// matching the repo's existing pattern (e.g. lib/chat/commands/model.test.ts).
vi.mock('@/lib/core/kv', () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

// createLogger hits filesystem/logback paths we don't want here; stub it.
vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { Mock } from 'vitest';
import { get as kvGet, set as kvSet } from '@/lib/core/kv';
import { getCachedSpeech, setCachedSpeech } from '@/lib/extra/audio/cache';

const INPUT = { text: 'hi', voice: 'alloy', format: 'mp3' };

describe('audio cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null on a miss (empty / undefined value)', async () => {
    (kvGet as Mock).mockResolvedValue(null);
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();

    (kvGet as Mock).mockResolvedValue('');
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();
  });

  it('round-trips a valid base64 value written by setCachedSpeech', async () => {
    const audio = new Uint8Array([0, 1, 2, 3, 250, 251]);
    (kvSet as Mock).mockResolvedValue(undefined);
    await setCachedSpeech(INPUT, audio);

    // setCachedSpeech stored canonical base64; reading it back must decode to
    // the exact same bytes. This guards the happy path that the malformed-value
    // check must NOT accidentally reject valid canonical base64.
    const stored: string = (kvSet as Mock).mock.calls[0]?.[1] ?? '';
    expect(stored).toBe(Buffer.from(audio).toString('base64'));
    (kvGet as Mock).mockResolvedValue(stored);
    await expect(getCachedSpeech(INPUT)).resolves.toEqual(audio);
  });

  it('treats a corrupted non-empty value as a miss (regression guard)', async () => {
    // Before the fix, this would have been decoded by Buffer.from(str,
    // 'base64') into garbage bytes and served to the client. The fix must
    // return null so the caller falls back to a fresh synthesis.
    (kvGet as Mock).mockResolvedValue('!!!not base64!!!');
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();
  });

  it('rejects base64 with the wrong length padding (not a canonical multiple of 4)', async () => {
    // A canonical base64 string is always a multiple of 4 chars; an odd-length
    // value can never be a real encode, so it must be a miss.
    (kvGet as Mock).mockResolvedValue('YWJjZDE'); // 7 chars, no valid padding
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();
  });

  it('rejects URL-safe base64 (-/_), which setCachedSpeech never writes', async () => {
    // setCachedSpeech always emits standard base64 (+/). A cached value using
    // the URL-safe alphabet means the data was written by something else or
    // corrupted in transit — treat as miss rather than decode ambiguously.
    (kvGet as Mock).mockResolvedValue('YWJj-ZGVf');
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();
  });

  it('swallows KV errors and returns null (cache must never throw)', async () => {
    (kvGet as Mock).mockRejectedValue(new Error('kv down'));
    await expect(getCachedSpeech(INPUT)).resolves.toBeNull();
  });
});
