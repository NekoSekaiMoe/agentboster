/**
 * Coalescing debounce for notifications.
 *
 * The existing `NotificationManager.isDuplicate` / `markSent` path does
 * 5-minute EXACT dedup (same taskId+type+channel → already-sent flag).
 * That covers "this exact notification was just sent, don't resend."
 *
 * This module covers a different need, inspired by AutoGPT's
 * `push_sender.py::_user_last_push` debounce: collapse MULTIPLE DIFFERENT
 * notifications sharing a coalesce key into a single send, so a burst of
 * related events (e.g. three tool-finished events for one session within
 * 5 seconds) produces ONE user-visible message instead of three.
 *
 * Mechanism (in-process):
 *  - First call for a coalesceKey within the window → schedule a timer
 *    for `windowMs`, remember the pending payload list.
 *  - Subsequent calls with the same key → append payload to the list,
 *    return `{ coalesced: true }` (caller knows it was swallowed).
 *  - When the timer fires → invoke the sender with the accumulated
 *    payloads; clear the slot.
 *  - `flush(key)` lets a caller force-send immediately (used at shutdown
 *    or when a burst is known to be complete).
 *
 * Why in-process (not Redis): the debounce window is seconds, not the
 * hours-long durability of the profile cache. A serverless cold-start
 * losing a pending 3-second timer just means the original `sendNotification`
 * fires per-event instead of coalesced — same UX as before this module
 * existed. Multi-instance coalescence would need Redis SETNX + pub/sub,
 * which is overkill for "don't spam the user for 5 seconds."
 */

import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('channels.notification.coalesce');

type PendingEntry<P> = {
  payloads: P[];
  timer: NodeJS.Timeout;
  /**
   * The sender passed when the window was opened. Retained so flush()
   * can dispatch even when the caller doesn't pass a fresh sender —
   * matches the documented "force-send the pending batch" contract.
   */
  sender: (batch: P[]) => Promise<void>;
};

const DEFAULT_WINDOW_MS = 5_000;
const MAX_PENDING_PER_KEY = 20;

export interface CoalesceSendResult {
  /** true = this call was swallowed into a pending batch (no send yet). */
  coalesced: boolean;
  /** true = this call triggered the actual send (first in window). */
  initiated: boolean;
  /** Number of payloads in the pending batch (1 for the initiator). */
  batchSize: number;
}

/**
 * Coalescing debouncer. Create one instance and reuse it; the registry
 * of pending windows lives on the instance so different call sites don't
 * share state unless they want to.
 *
 * Usage:
 * ```ts
 * const debouncer = new NotificationCoalescer();
 * const result = await debouncer.send({
 *   coalesceKey: `session:${sessionId}:tool`,
 *   windowMs: 5000,
 *   payload: notif,
 *   sender: async (batch) => sendNotification(batch[0]),
 * });
 * ```
 */
export class NotificationCoalescer {
  private pending = new Map<string, PendingEntry<unknown>>();

  /**
   * Add a payload to the coalesce window for `coalesceKey`.
   *
   * - If no window is open → start one, return `{ initiated: true }`.
   *   The sender fires exactly once, after `windowMs`, with the full batch.
   * - If a window is already open → append the payload, return
   *   `{ coalesced: true }`. The sender does NOT fire for this call.
   *
   * The sender receives ALL accumulated payloads; the default for most
   * channels is to send just the first (the most informative) and drop
   * the rest — that's why the sender signature takes the whole array.
   */
  send<P>(input: {
    coalesceKey: string;
    payload: P;
    windowMs?: number;
    sender: (batch: P[]) => Promise<void>;
  }): CoalesceSendResult {
    const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
    const existing = this.pending.get(input.coalesceKey);

    if (existing) {
      // Cap the batch to bound memory if a misbehaving caller fires
      // hundreds of events under one key. Extra payloads are dropped
      // (coalesced: true but not enqueued) — logged so the loss is visible.
      if (existing.payloads.length >= MAX_PENDING_PER_KEY) {
        logger.warn('coalesce:batch_capped', {
          coalesceKey: input.coalesceKey,
          cap: MAX_PENDING_PER_KEY,
        });
        return {
          coalesced: true,
          initiated: false,
          batchSize: existing.payloads.length,
        };
      }
      existing.payloads.push(input.payload);
      return {
        coalesced: true,
        initiated: false,
        batchSize: existing.payloads.length,
      };
    }

    // Initiate a new window. The timer fires the sender with the full
    // batch, then clears the slot so the next call starts a fresh window.
    const payloads: P[] = [input.payload];
    const entry: PendingEntry<P> = {
      payloads,
      sender: input.sender,
      // try/catch captures a SYNCHRONOUS throw from input.sender (before
      // it returns a promise); the .catch on the returned promise handles
      // async rejections. Both paths log + swallow so a broken sender
      // doesn't escape the setTimeout callback. Using try/catch (rather
      // than Promise.resolve().then(...)) keeps the sender invocation
      // synchronous, matching the prior contract that the sender body
      // runs inside the timer tick — important for fake-timer tests that
      // assert the call happened during advanceTimersByTime.
      timer: setTimeout(() => {
        this.pending.delete(input.coalesceKey);
        let result: unknown;
        try {
          result = input.sender(payloads);
        } catch (error) {
          logger.warn('coalesce:sender_failed', {
            coalesceKey: input.coalesceKey,
            batchSize: payloads.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        Promise.resolve(result as Promise<unknown>).catch((error) => {
          logger.warn('coalesce:sender_failed', {
            coalesceKey: input.coalesceKey,
            batchSize: payloads.length,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, windowMs),
    };

    // Make the timer removable on flush(). Unref so the timer doesn't
    // keep an exiting Node process alive (matches the existing
    // notification-manager escalation timer pattern).
    entry.timer.unref?.();

    this.pending.set(input.coalesceKey, entry as PendingEntry<unknown>);
    return { coalesced: false, initiated: true, batchSize: 1 };
  }

  /**
   * Force-send the pending batch for `coalesceKey` immediately, clearing
   * the timer. Returns true if a batch was flushed, false if no window
   * was open.
   *
   * Call this when the caller knows the burst is over (e.g. a workflow
   * finished) and doesn't want to wait for the window to elapse.
   */
  async flush<P = unknown>(
    coalesceKey: string,
    sender?: (batch: P[]) => Promise<void>,
  ): Promise<boolean> {
    const entry = this.pending.get(coalesceKey);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(coalesceKey);
    // Prefer the explicitly-provided sender; fall back to the sender
    // captured when the window was opened so an omitted-sender flush
    // still dispatches the pending batch instead of silently dropping it.
    const effectiveSender =
      sender ?? (entry.sender as (batch: P[]) => Promise<void>);
    if (effectiveSender) {
      try {
        await effectiveSender(entry.payloads as P[]);
      } catch (error) {
        logger.warn('flush:sender_failed', {
          coalesceKey,
          batchSize: entry.payloads.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  /**
   * Number of currently-open coalesce windows. Test/diagnostic helper.
   */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Process-wide default coalescer. Most call sites should use this rather
 * than instantiating their own, so bursts across modules collapse into
 * one window per key. Constructed lazily so it never runs at import time.
 */
let defaultCoalescer: NotificationCoalescer | null = null;
export function getNotificationCoalescer(): NotificationCoalescer {
  if (!defaultCoalescer) defaultCoalescer = new NotificationCoalescer();
  return defaultCoalescer;
}
