/**
 * L2 IM confirmation callback.
 *
 * Triggered when a user taps a button on an L2 authorization prompt
 * delivered via IM (Telegram/Discord/etc.). Previously this route only
 * updated task status and (for pass_until/reject_until) wrote a KV
 * entry — but it never resolved the Web-side DecisionQueue entry nor
 * forwarded the verdict to the daemon, so:
 *   - The Web decision stayed PENDING until its 5-min timeout.
 *   - The daemon's agent loop stayed blocked on L2 confirmation
 *     (the daemon waits for an eventbus EventL2AuthApproved/Rejected
 *     that never arrived, eventually timing out).
 *   - The KV "window" was write-and-forget (never read).
 *
 * This rewrite fixes the root cause: each action branch now forwards
 * the verdict to the daemon via forwardL2Confirm(). The daemon's
 * handleL2Confirm then publishes EventL2AuthApproved/Rejected, which
 * (1) unblocks the waiting agent loop for this task and (2) records
 * the pattern in the daemon's L2AuthManager cache so future identical
 * commands are short-circuited locally — that cache is the real
 * "pass_until" implementation, and it was simply never being fed.
 *
 * The old l2:auth:* KV write is removed: it was keyed by taskId:chatId
 * (taskId is unique per request, so the key could never match a future
 * request) and nothing read it. The daemon-side pattern cache covers
 * the "future similar commands" case correctly.
 *
 * The Web-side DecisionQueue.resolve()/deny() is also called for each
 * action so the in-memory queue stops tracking the entry and any
 * waitForResolution() caller unblocks.
 *
 * The actual processing logic lives in lib/extra/agent/l2-decision.ts
 * so that the IM bot action handler (lib/bot/index.ts bot.onAction
 * catch-all) can call the same code without an internal HTTP
 * round-trip. This file is a thin HTTP-shaped wrapper.
 */

export const dynamic = 'force-dynamic';

import { processL2Decision } from '@/lib/extra/agent/l2-decision';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.l2-confirm');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, decisionId, action, timeInput, chatId, userId } = body;

    const outcome = await processL2Decision({
      taskId,
      decisionId,
      action,
      timeInput,
      chatId,
      userId,
    });

    return Response.json(
      outcome.success
        ? {
            success: true,
            data: {
              taskId,
              message: outcome.message,
              ...(outcome.awaitingTimeInput
                ? { awaitingTimeInput: true }
                : {}),
            },
          }
        : { success: false, error: outcome.error },
      { status: outcome.status },
    );
  } catch (error) {
    logger.error('L2 confirmation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to process L2 confirmation' },
      { status: 500 },
    );
  }
}
