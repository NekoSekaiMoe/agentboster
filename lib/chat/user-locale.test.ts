import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer before importing the module under test.
vi.mock('@/lib/core/db/chat', () => ({
  listSessions: vi.fn(async () => []),
  listSessionsByExternalThreadIds: vi.fn(async () => []),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

import {
  resolveUserLocale,
  resolveThreadLocale,
} from '@/lib/chat/user-locale';
import { listSessions, listSessionsByExternalThreadIds } from '@/lib/core/db/chat';

describe('user-locale resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when userId is empty', async () => {
    expect(await resolveUserLocale('')).toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('returns the locale from the first matching session', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { metadata: { locale: 'zh-CN' } },
      { metadata: { locale: 'ja' } },
    ] as never);
    expect(await resolveUserLocale('u1')).toBe('zh-CN');
  });

  it('skips sessions with locale === "auto" and keeps looking', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { metadata: { locale: 'auto' } },
      { metadata: { locale: 'ko' } },
    ] as never);
    expect(await resolveUserLocale('u1')).toBe('ko');
  });

  it('skips sessions with invalid locale strings', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { metadata: { locale: 'not-a-locale' } },
      { metadata: { locale: 'en-US' } },
    ] as never);
    expect(await resolveUserLocale('u1')).toBe('en-US');
  });

  it('returns null when no session has a usable locale', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { metadata: {} },
      { metadata: { locale: null } },
    ] as never);
    expect(await resolveUserLocale('u1')).toBeNull();
  });

  it('returns null when the DB throws', async () => {
    vi.mocked(listSessions).mockRejectedValueOnce(new Error('db down'));
    expect(await resolveUserLocale('u1')).toBeNull();
  });

  it('resolveThreadLocale ignores empty ids', async () => {
    expect(await resolveThreadLocale(['', '  '])).toBeNull();
    expect(listSessionsByExternalThreadIds).not.toHaveBeenCalled();
  });

  it('resolveThreadLocale reads from the first matching session', async () => {
    vi.mocked(listSessionsByExternalThreadIds).mockResolvedValueOnce([
      { metadata: { locale: 'ja' } },
    ] as never);
    expect(await resolveThreadLocale(['t1'])).toBe('ja');
  });
});
