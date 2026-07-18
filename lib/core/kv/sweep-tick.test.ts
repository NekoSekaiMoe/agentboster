/**
 * Tests for the throttled self-hosted KV sweep driver.
 *
 * The unit under test is the gating/throttle logic in maybeSweepExpiredKv —
 * NOT the sweep SQL (that lives in pg-backend). We mock both `@/lib/extra/deploy`
 * (deployment mode) and `./pg-backend` (the actual DELETE) so these tests
 * exercise only: the self-hosted gate, the per-process time throttle, and the
 * in-flight de-dup.
 *
 * The module holds mutable module-level state (`_lastSweepAt`, `_inFlight`),
 * so each test does `vi.resetModules()` + a fresh dynamic import to start from
 * a clean slate, and re-declares the mocks for that module registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweepExpiredKv = vi.fn<() => Promise<number>>();

// isSelfHosted is read at maybeSweepExpiredKv call time (not module load), but
// the value comes from `@/lib/extra/deploy` which reads env once at load. We mock the
// module wholesale and flip `isSelfHosted` per test via the factory closure.
let selfHosted = true;

vi.mock('@/lib/extra/deploy', () => ({
  get isSelfHosted() {
    return selfHosted;
  },
  get isVercel() {
    return !selfHosted;
  },
}));

vi.mock('./pg-backend', () => ({
  sweepExpiredKv: () => sweepExpiredKv(),
}));

async function freshModule() {
  vi.resetModules();
  return import('./sweep-tick');
}

beforeEach(() => {
  selfHosted = true;
  sweepExpiredKv.mockReset();
  sweepExpiredKv.mockResolvedValue(3);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeSweepExpiredKv', () => {
  it('runs the sweep on the first call when self-hosted', async () => {
    const { maybeSweepExpiredKv } = await freshModule();
    const removed = await maybeSweepExpiredKv();
    expect(removed).toBe(3);
    expect(sweepExpiredKv).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on Vercel (never touches pg-backend)', async () => {
    selfHosted = false;
    const { maybeSweepExpiredKv } = await freshModule();
    const removed = await maybeSweepExpiredKv();
    expect(removed).toBe(0);
    expect(sweepExpiredKv).not.toHaveBeenCalled();
  });

  it('throttles: a second call within the interval is skipped', async () => {
    const { maybeSweepExpiredKv, SWEEP_MIN_INTERVAL_MS } = await freshModule();
    const t0 = 1_000_000;
    await maybeSweepExpiredKv(t0);
    // Still inside the window → skipped, returns 0, no extra sweep.
    const second = await maybeSweepExpiredKv(t0 + SWEEP_MIN_INTERVAL_MS - 1);
    expect(second).toBe(0);
    expect(sweepExpiredKv).toHaveBeenCalledTimes(1);
  });

  it('runs again once the interval has fully elapsed', async () => {
    const { maybeSweepExpiredKv, SWEEP_MIN_INTERVAL_MS } = await freshModule();
    const t0 = 1_000_000;
    await maybeSweepExpiredKv(t0);
    const later = await maybeSweepExpiredKv(t0 + SWEEP_MIN_INTERVAL_MS);
    expect(later).toBe(3);
    expect(sweepExpiredKv).toHaveBeenCalledTimes(2);
  });

  it('de-dups concurrent calls: only one sweep runs while in flight', async () => {
    // Make the sweep hang until we release it, so both calls overlap.
    let release!: (n: number) => void;
    sweepExpiredKv.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const { maybeSweepExpiredKv, SWEEP_MIN_INTERVAL_MS } = await freshModule();
    const t0 = 1_000_000;
    // First call starts the (hanging) sweep and claims the window.
    const first = maybeSweepExpiredKv(t0);

    // The helper `await import('./pg-backend')`s before invoking the sweep, so
    // the mock body (which assigns `release`) runs an indeterminate number of
    // microtasks later. Wait until the sweep is actually in flight rather than
    // guessing a fixed number of flushes.
    await vi.waitFor(() => expect(sweepExpiredKv).toHaveBeenCalledTimes(1));

    // Second call is PAST the time throttle (interval fully elapsed) but the
    // first sweep is still hanging → the in-flight guard, not the throttle,
    // must skip it. It returns 0 without starting a second sweep.
    const second = await maybeSweepExpiredKv(t0 + SWEEP_MIN_INTERVAL_MS);
    expect(second).toBe(0);

    release(7);
    expect(await first).toBe(7);
    // Exactly one sweep ran across both overlapping calls.
    expect(sweepExpiredKv).toHaveBeenCalledTimes(1);
  });
});
