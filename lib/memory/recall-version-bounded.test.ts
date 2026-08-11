import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/memory/shared-version', () => ({
  readSharedMemoryVersion: vi.fn(),
  bumpSharedMemoryVersion: vi.fn(),
  sharedMemoryVersionKey: (workspaceId: string) =>
    `memory_version:${workspaceId}`,
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const WORKSPACE = 'ws-bounded-test';

type Bounded = typeof import('./recall').readSharedMemoryVersionBounded;

describe('readSharedMemoryVersionBounded', () => {
  let readSharedMemoryVersionBounded: Bounded;
  let mockRead: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // The failure cache is module-level state — reset modules so each
    // test starts with a cold cache, then re-grab the fresh mocked read.
    // NOTE: fake timers must be enabled AFTER the dynamic imports —
    // module evaluation may rely on real timers and would hang the hook.
    vi.resetModules();
    const sharedVersion = await import('@/lib/memory/shared-version');
    mockRead = vi.mocked(sharedVersion.readSharedMemoryVersion);
    mockRead.mockReset();
    ({ readSharedMemoryVersionBounded } = await import('./recall'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through a successful read without arming the failure cache', async () => {
    mockRead.mockResolvedValue({ ok: true, version: 7 });

    await expect(readSharedMemoryVersionBounded(WORKSPACE)).resolves.toEqual({
      ok: true,
      version: 7,
    });
    // A success must not poison the cache: the next call reads again.
    await readSharedMemoryVersionBounded(WORKSPACE);
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false on timeout and short-circuits subsequent reads', async () => {
    mockRead.mockReturnValue(new Promise(() => {})); // hangs forever

    const first = readSharedMemoryVersionBounded(WORKSPACE);
    await vi.advanceTimersByTimeAsync(250);
    await expect(first).resolves.toEqual({ ok: false });
    expect(mockRead).toHaveBeenCalledTimes(1);

    // Inside the failure window the KV read is skipped entirely.
    await expect(readSharedMemoryVersionBounded(WORKSPACE)).resolves.toEqual({
      ok: false,
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('resumes reads after the failure window expires', async () => {
    mockRead.mockReturnValueOnce(new Promise(() => {}));
    const first = readSharedMemoryVersionBounded(WORKSPACE);
    await vi.advanceTimersByTimeAsync(250);
    await expect(first).resolves.toEqual({ ok: false });

    mockRead.mockResolvedValue({ ok: true, version: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(readSharedMemoryVersionBounded(WORKSPACE)).resolves.toEqual({
      ok: true,
      version: 1,
    });
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('caches quick failures (ok:false) too, not only timeouts', async () => {
    mockRead.mockResolvedValue({ ok: false });

    await expect(readSharedMemoryVersionBounded(WORKSPACE)).resolves.toEqual({
      ok: false,
    });
    await readSharedMemoryVersionBounded(WORKSPACE);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });
});
