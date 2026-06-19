import { getBaseBot } from '@/lib/bot/core';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import { getWorkflowStatus } from '@/lib/workflow/agent/dispatch';

const logger = createLogger('bot.typing_pump');

/** Telegram typing indicator expires after ~5s; refresh just before. */
const TYPING_REFRESH_MS = 4500;
/** Max time to keep the pump running, regardless of workflow status. */
const TYPING_PUMP_MAX_MS = 5 * 60 * 1000;
/** How often to poll workflow status (separate from typing refresh). */
const STATUS_POLL_MS = 2000;

/**
 * Drive the IM typing indicator from the webhook function's `after()`
 * task for the duration of a workflow run.
 *
 * Why this lives here and not inside the workflow runtime: the workflow
 * runtime forbids setInterval/setTimeout (determinism), so a typing
 * refresh loop cannot run inside chatWorkflow. But typing is UI
 * feedback, not durable business logic — running it in the webhook
 * function's after() task is the right layer. The webhook returns 200
 * immediately (it does not block on the typing pump); after() keeps the
 * function's background task alive, refreshing the indicator every
 * TYPING_REFRESH_MS until the workflow reaches a terminal status.
 *
 * The pump is best-effort and bounded:
 * - If the function is reclaimed at its maxDuration, the pump stops
 *   early — acceptable, the workflow continues and posts the reply via
 *   onStepFinish regardless.
 * - If the adapter doesn't support startTyping, the call is swallowed.
 * - We poll workflow status on a separate cadence and stop refreshing
 *   once the run is no longer active.
 *
 * Call this from a `void` context (fire-and-forget inside after()).
 * Errors are caught and logged — never throw out of the pump.
 */
export async function runTypingPumpUntilDone(input: {
  source: Extract<ChatSource, { type: 'im' }>;
  runId: string;
}): Promise<void> {
  const { source, runId } = input;
  const startedAt = Date.now();

  let bot: Awaited<ReturnType<typeof getBaseBot>>;
  try {
    bot = await getBaseBot();
  } catch (error) {
    logger.warn('typing_pump:init_failed', {
      adapter: source.adapter,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let adapter: ReturnType<typeof bot.getAdapter>;
  try {
    adapter = bot.getAdapter(source.adapter);
  } catch {
    // Adapter not configured/enabled — nothing to refresh.
    return;
  }

  const refresh = async () => {
    try {
      await adapter.startTyping(source.threadId);
    } catch (error) {
      // Best-effort: many adapters don't support typing or rate-limit it.
      logger.info('typing_pump:refresh_failed', {
        adapter: source.adapter,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // First tick immediately so the indicator appears without waiting for
  // the first interval.
  await refresh();

  let stillActive = true;
  const typingTimer = setInterval(refresh, TYPING_REFRESH_MS);

  // Status-poll loop: resolve when the workflow leaves ACTIVE status.
  // Uses a separate interval (not sleep — this is the webhook function,
  // not the workflow runtime) and stops the typing timer on exit.
  const statusTimer = setInterval(async () => {
    try {
      if (Date.now() - startedAt > TYPING_PUMP_MAX_MS) {
        stillActive = false;
        return;
      }
      const status = await getWorkflowStatus(runId);
      if (!status || status === 'unknown') {
        // Status lookup failed transiently; keep refreshing while we
        // still believe the run is alive (bounded by max_ms above).
        return;
      }
      const isActive = await import('@/lib/workflow/agent/config')
        .then((m) => m.ACTIVE_RUN_STATUSES)
        .then((s) => s.has(status));
      if (!isActive) {
        stillActive = false;
      }
    } catch {
      // Swallow — keep refreshing until the max-time safety net fires.
    }
  }, STATUS_POLL_MS);

  // Wait until the status poll flips `stillActive`. We poll the flag on
  // a short cadence rather than awaiting the statusTimer callback
  // directly because setInterval callbacks are fire-and-forget.
  await new Promise<void>((resolve) => {
    const waiter = setInterval(() => {
      if (!stillActive) {
        clearInterval(waiter);
        resolve();
      }
    }, STATUS_POLL_MS);
  });

  clearInterval(typingTimer);
  clearInterval(statusTimer);
  logger.info('typing_pump:done', {
    adapter: source.adapter,
    runId,
    elapsedMs: Date.now() - startedAt,
  });
}
