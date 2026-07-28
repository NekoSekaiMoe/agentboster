/**
 * Tests for the coalescing debouncer.
 *
 * Uses fake timers because the debounce window is timer-based. Without
 * fakes, a 5-second window would make the test suite slow and flaky.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationCoalescer } from './coalesce';

describe('NotificationCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initiates on first call and coalesces subsequent calls in the window', () => {
    const debouncer = new NotificationCoalescer();
    const sender = vi.fn().mockResolvedValue(undefined);

    const first = debouncer.send({
      coalesceKey: 'session-1',
      payload: { n: 1 },
      sender,
    });
    expect(first).toEqual({ coalesced: false, initiated: true, batchSize: 1 });

    const second = debouncer.send({
      coalesceKey: 'session-1',
      payload: { n: 2 },
      sender,
    });
    expect(second).toEqual({ coalesced: true, initiated: false, batchSize: 2 });

    const third = debouncer.send({
      coalesceKey: 'session-1',
      payload: { n: 3 },
      sender,
    });
    expect(third.batchSize).toBe(3);
    expect(third.coalesced).toBe(true);

    // Sender hasn't fired yet — window hasn't elapsed.
    expect(sender).not.toHaveBeenCalled();

    // Advance past the default 5s window.
    vi.advanceTimersByTime(5000);

    expect(sender).toHaveBeenCalledTimes(1);
    // The sender received the full batch in arrival order.
    expect(sender).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('starts a fresh window after the previous one fires', () => {
    const debouncer = new NotificationCoalescer();
    const sender = vi.fn().mockResolvedValue(undefined);

    debouncer.send({ coalesceKey: 'k', payload: 'a', sender });
    vi.advanceTimersByTime(5000);
    expect(sender).toHaveBeenCalledWith(['a']);

    // A new call after the window starts a new batch.
    const result = debouncer.send({ coalesceKey: 'k', payload: 'b', sender });
    expect(result.initiated).toBe(true);
    expect(result.batchSize).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(sender).toHaveBeenLastCalledWith(['b']);
  });

  it('isolates different coalesce keys', () => {
    const debouncer = new NotificationCoalescer();
    const sender = vi.fn().mockResolvedValue(undefined);

    debouncer.send({ coalesceKey: 'a', payload: 1, sender });
    debouncer.send({ coalesceKey: 'b', payload: 100, sender });
    debouncer.send({ coalesceKey: 'a', payload: 2, sender });

    vi.advanceTimersByTime(5000);

    expect(sender).toHaveBeenCalledTimes(2);
    // Order of keys isn't guaranteed across separate timers, so check by
    // matching the batch contents.
    const calls = sender.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual([1, 2]);
    expect(calls).toContainEqual([100]);
  });

  it('flush sends the pending batch immediately and clears the window', async () => {
    const debouncer = new NotificationCoalescer();
    const batchSender = vi.fn().mockResolvedValue(undefined);

    debouncer.send({ coalesceKey: 'k', payload: 'x', sender: batchSender });
    debouncer.send({ coalesceKey: 'k', payload: 'y', sender: batchSender });

    const flushSender = vi.fn().mockResolvedValue(undefined);
    const flushed = await debouncer.flush('k', flushSender);

    expect(flushed).toBe(true);
    expect(flushSender).toHaveBeenCalledWith(['x', 'y']);

    // The pending timer was cleared — advancing time does NOT fire the
    // original sender a second time.
    vi.advanceTimersByTime(10_000);
    expect(batchSender).not.toHaveBeenCalled();
  });

  it('flush returns false when no window is open', async () => {
    const debouncer = new NotificationCoalescer();
    const flushed = await debouncer.flush('nope');
    expect(flushed).toBe(false);
  });

  it('caps batch size and drops extras while reporting coalesced=true', () => {
    const debouncer = new NotificationCoalescer();
    const sender = vi.fn().mockResolvedValue(undefined);

    // Fire MAX + a few extras under one key.
    for (let i = 0; i < 25; i++) {
      debouncer.send({ coalesceKey: 'k', payload: i, sender });
    }

    // The cap is 20; the last 5 payloads report coalesced:true but are
    // not enqueued. The batchSize returned still reflects the cap.
    vi.advanceTimersByTime(5000);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toHaveLength(20);
  });

  it('logs (not throws) when the sender rejects', () => {
    const debouncer = new NotificationCoalescer();
    const failingSender = vi.fn().mockRejectedValue(new Error('boom'));

    debouncer.send({ coalesceKey: 'k', payload: 1, sender: failingSender });

    // Rejection is swallowed by the fire-and-forget wrapper; advancing
    // time must not throw out of the timer callback.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });

  it('logs (not throws) when the sender throws synchronously', () => {
    const debouncer = new NotificationCoalescer();
    // A sender that throws BEFORE returning a promise — a bare
    // .catch() on the return value would miss this, so the timer
    // wrapper must use Promise.resolve().then(...) to capture it.
    const throwingSender = vi.fn(() => {
      throw new Error('sync boom');
    });

    debouncer.send({ coalesceKey: 'k', payload: 1, sender: throwingSender });

    // The synchronous throw inside the timer callback must be caught by
    // the wrapper; advancing time must not throw.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });

  it('flush dispatches the pending batch using the captured sender when none is passed', async () => {
    const debouncer = new NotificationCoalescer();
    const capturedSender = vi.fn().mockResolvedValue(undefined);

    debouncer.send({ coalesceKey: 'k', payload: 'x', sender: capturedSender });
    debouncer.send({ coalesceKey: 'k', payload: 'y', sender: capturedSender });

    // flush() with NO explicit sender must still dispatch via the
    // sender captured when the window was opened.
    const flushed = await debouncer.flush('k');
    expect(flushed).toBe(true);
    expect(capturedSender).toHaveBeenCalledTimes(1);
    expect(capturedSender).toHaveBeenCalledWith(['x', 'y']);
  });
});
