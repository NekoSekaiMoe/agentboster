/**
 * Tests for the IM message dedup logic.
 *
 * checkDuplicate / recordMessage gate IM inbound messages against a
 * short KV-backed history. The module has three independent dedup
 * channels: platform messageId, client idempotency key, and text
 * similarity (Jaccard ≥ 0.7 over normalized tokens) within a 5-minute
 * TTL. KV is mocked.
 *
 * Regression focus: the three channels, TTL expiry, the 0.7 threshold
 * boundary, normalization (case/punctuation/whitespace), and the
 * skipDedup short-circuit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// KV mock: a tiny in-memory store keyed by string.
const kvStore = new Map<string, string>();
vi.mock('@/lib/core/kv', () => ({
  get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    kvStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    kvStore.delete(key);
  }),
}));

import {
  checkDuplicate,
  checkIdempotencyDuplicate,
  recordIdempotencyMessage,
  recordMessage,
} from './dedup';
import type { IMChatSource } from '@/types/workflow';

const SOURCE: IMChatSource = {
  type: 'im',
  adapter: 'telegram',
  userId: 'user-1',
  origin: 'origin',
  threadId: 't1',
  messageId: '',
};

beforeEach(() => {
  kvStore.clear();
});

describe('checkDuplicate — skipDedup short-circuit', () => {
  it('returns null immediately regardless of stored state', async () => {
    kvStore.set(
      `dedup:msg:telegram:user-1`,
      JSON.stringify({ text: 'hi', sessionId: 's', ts: Date.now() }),
    );
    expect(await checkDuplicate(SOURCE, 'hi', { skipDedup: true })).toBeNull();
  });
});

describe('checkDuplicate — messageId channel', () => {
  it('detects a duplicate by platform messageId', async () => {
    await recordMessage(SOURCE, 'first', 'sess-1', {
      messageId: 'm-100',
    });
    const dup = await checkDuplicate(SOURCE, 'different text', {
      messageId: 'm-100',
    });
    expect(dup).toEqual({
      type: 'duplicate',
      sessionId: 'sess-1',
      similarity: 1,
      reason: 'message_id',
    });
  });

  it('returns null for an unseen messageId', async () => {
    expect(
      await checkDuplicate(SOURCE, 'x', { messageId: 'm-new' }),
    ).toBeNull();
  });
});

describe('checkDuplicate — idempotencyKey channel', () => {
  it('detects a duplicate by client idempotency key', async () => {
    await recordMessage(SOURCE, 'first', 'sess-2', {
      idempotencyKey: 'idem-7',
    });
    const dup = await checkDuplicate(SOURCE, 'different text', {
      idempotencyKey: 'idem-7',
    });
    expect(dup?.reason).toBe('idempotency_key');
    expect(dup?.sessionId).toBe('sess-2');
  });

  it('checkIdempotencyDuplicate is a standalone helper for the same channel', async () => {
    await recordIdempotencyMessage('idem-9', 'payload', 'sess-9');
    const dup = await checkIdempotencyDuplicate('idem-9');
    expect(dup?.reason).toBe('idempotency_key');
    expect(dup?.sessionId).toBe('sess-9');
  });
});

describe('checkDuplicate — similarity channel', () => {
  it('flags near-duplicate text within the TTL window (≥ 0.7)', async () => {
    await recordMessage(SOURCE, 'please help me fix the bug', 'sess-sim');
    const dup = await checkDuplicate(SOURCE, 'please help me fix the bug now');
    expect(dup?.reason).toBe('similarity');
    expect(dup?.sessionId).toBe('sess-sim');
    expect(dup?.similarity).toBeGreaterThanOrEqual(0.7);
  });

  it('does NOT flag clearly different text (< 0.7)', async () => {
    await recordMessage(SOURCE, 'please help me fix the bug', 'sess-sim');
    expect(
      await checkDuplicate(SOURCE, 'what is the weather in tokyo today'),
    ).toBeNull();
  });

  it('normalizes case + punctuation before comparing', async () => {
    // Punctuation/case differences should collapse so the similarity
    // check sees the same tokens.
    await recordMessage(SOURCE, 'Hello, World!', 'sess-norm');
    const dup = await checkDuplicate(SOURCE, 'hello world');
    expect(dup?.reason).toBe('similarity');
  });

  it('scopes similarity to the same (adapter, userId)', async () => {
    await recordMessage(SOURCE, 'hello world this is a test', 'sess-a');
    const otherUser: IMChatSource = { ...SOURCE, userId: 'user-2' };
    // A different user has no recorded history → not a duplicate.
    expect(
      await checkDuplicate(otherUser, 'hello world this is a test'),
    ).toBeNull();
  });
});

describe('checkDuplicate — TTL expiry', () => {
  it('treats a record older than 5 minutes as stale (no similarity match)', async () => {
    // Plant a record with a stale timestamp directly in the KV store.
    kvStore.set(
      `dedup:msg:telegram:user-1`,
      JSON.stringify({
        text: 'hello world foo bar baz',
        sessionId: 'sess-old',
        ts: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      }),
    );
    expect(await checkDuplicate(SOURCE, 'hello world foo bar baz')).toBeNull();
  });

  it('honors a record just under the 5-minute TTL', async () => {
    kvStore.set(
      `dedup:msg:telegram:user-1`,
      JSON.stringify({
        text: 'hello world foo bar baz',
        sessionId: 'sess-fresh',
        ts: Date.now() - 60 * 1000, // 1 minute ago
      }),
    );
    const dup = await checkDuplicate(SOURCE, 'hello world foo bar baz');
    expect(dup?.reason).toBe('similarity');
  });
});

describe('checkDuplicate — malformed stored data', () => {
  it('returns null when the scoped record is corrupt JSON', async () => {
    kvStore.set(`dedup:msg:telegram:user-1`, '{not json');
    expect(await checkDuplicate(SOURCE, 'anything')).toBeNull();
  });

  it('returns null when an exact-key record is corrupt JSON', async () => {
    kvStore.set(`dedup:platform:telegram:m-1`, '{not json');
    expect(await checkDuplicate(SOURCE, 'x', { messageId: 'm-1' })).toBeNull();
  });
});

describe('recordMessage — writes all keyed entries', () => {
  it('writes the scoped, platform, and idempotency keys when all are present', async () => {
    await recordMessage(SOURCE, 'msg', 'sess-w', {
      messageId: 'm-w',
      idempotencyKey: 'idem-w',
    });
    expect(kvStore.has(`dedup:msg:telegram:user-1`)).toBe(true);
    expect(kvStore.has(`dedup:platform:telegram:m-w`)).toBe(true);
    expect(kvStore.has(`dedup:idempotency:idem-w`)).toBe(true);
  });

  it('writes only the scoped key when neither messageId nor idempotencyKey is set', async () => {
    await recordMessage(SOURCE, 'msg', 'sess-w');
    expect(kvStore.has(`dedup:msg:telegram:user-1`)).toBe(true);
    expect(kvStore.size).toBe(1);
  });

  it('is a no-op when skipDedup is set', async () => {
    await recordMessage(SOURCE, 'msg', 'sess-w', { skipDedup: true });
    expect(kvStore.size).toBe(0);
  });
});
