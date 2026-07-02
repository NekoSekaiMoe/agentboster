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
 */

export const dynamic = 'force-dynamic';

import { forwardL2Confirm } from '@/lib/extra/agent/agentd-client';
import { updateTaskStatus } from '@/lib/core/db/agentd';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';
import { ensureNotificationChannels } from '@/lib/extra/channels/register-channels';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { getConfig } from '@/lib/core/kv/config';

const logger = createLogger('api.agentd.l2-confirm');

const DURATION_RE = /^(always|\d{8})$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, decisionId, action, timeInput, chatId, userId } = body;

    if (!taskId || !decisionId || !action) {
      return Response.json(
        {
          success: false,
          error: 'Missing required fields: taskId, decisionId, action',
        },
        { status: 400 },
      );
    }

    const mgr = getNotificationManager();

    // Lazily register notification channels from live config so that
    // sendL2Decision / sendL2TimeInputPrompt actually find a channel.
    const config = await getConfig();
    ensureNotificationChannels(config);

    // Decision dedup — ignore duplicate clicks from multiple IM channels
    const alreadyProcessed = await mgr.isDecisionProcessed(decisionId);
    if (alreadyProcessed) {
      logger.info('L2 decision already processed (dedup)', {
        taskId,
        decisionId,
        action,
      });
      return Response.json({
        success: true,
        data: { taskId, decision: action, message: 'Already processed.' },
      });
    }

    logger.info('L2 confirmation received', {
      taskId,
      decisionId,
      action,
      timeInput,
      chatId,
      userId,
    });

    // Command is needed for the daemon `pattern` field (used to key the
    // L2AuthManager cache for future identical commands). Prefer the
    // cached decision (authoritative); fall back to the L2 notification
    // context if the decision has expired out of the in-memory cache.
    const queue = getDecisionQueue();
    const decision = queue.get(decisionId);
    const resolvedBy = userId ?? 'im-user';
    const ctx = mgr.getL2Context(decisionId);
    const command = decision?.command ?? ctx?.taskId ?? taskId;

    // ── Handle pass_once ──────────────────────────────────────────────
    if (action === 'pass_once') {
      await mgr.markDecisionProcessed(decisionId);
      await updateTaskStatus(taskId, 'running', 'L2 authorized: pass_once');

      await finalizeDecision(decisionId, 'pass', resolvedBy, decision);
      await forwardToDaemon(taskId, decisionId, 'pass_once', command, 'once');

      return Response.json({
        success: true,
        data: {
          taskId,
          decision: 'pass_once',
          message: '✅ 已放行。任务继续执行。',
        },
      });
    }

    // ── Handle reject_once ────────────────────────────────────────────
    if (action === 'reject_once') {
      await mgr.markDecisionProcessed(decisionId);
      await updateTaskStatus(
        taskId,
        'cancelled',
        'Rejected by user via L2 authorization (reject_once)',
      );

      await finalizeDecision(decisionId, 'reject', resolvedBy, decision);
      await forwardToDaemon(taskId, decisionId, 'reject_once', command, 'once');

      return Response.json({
        success: true,
        data: {
          taskId,
          decision: 'reject_once',
          message: '❌ 已拒绝。任务已取消。',
        },
      });
    }

    // ── Handle pass_until / reject_until — Step 1: prompt for time ───
    if (action === 'pass_until' || action === 'reject_until') {
      if (!timeInput) {
        // First click — send time input prompt
        const cmdForPrompt = ctx?.taskId ? ctx.taskId : 'unknown';

        const prefs = userId
          ? await import('@/lib/core/db/notification').then((m) =>
              m.getNotificationPreferences(userId),
            )
          : null;
        const channel = prefs?.preferredChannel ?? 'telegram';

        await mgr.sendL2TimeInputPrompt({
          taskId,
          decisionId,
          action,
          command: cmdForPrompt,
          channel,
          targetChatId: chatId,
        });

        return Response.json({
          success: true,
          data: {
            taskId,
            decision: action,
            awaitingTimeInput: true,
            message: '⏱️ 请回复时间。格式：hhddmmyy 或 always。',
          },
        });
      }

      // ── Time input received — validate ─────────────────────────────
      if (!DURATION_RE.test(timeInput)) {
        return Response.json(
          {
            success: false,
            error:
              '⚠️ 格式错误。请输入 8 位数字（hhddmmyy）或 always。`01000000`=1小时，`00010000`=1天',
          },
          { status: 400 },
        );
      }

      const windowLabel =
        timeInput === 'always' ? '本次会话内' : formatWindowLabel(timeInput);

      await mgr.markDecisionProcessed(decisionId);

      const isPass = action === 'pass_until';
      const emoji = isPass ? '✅' : '🔕';
      const verb = isPass ? '放行' : '拒绝';
      const scopeLabel =
        timeInput === 'always' ? windowLabel : `未来 ${windowLabel}`;

      if (isPass) {
        await updateTaskStatus(
          taskId,
          'running',
          `L2 authorized: pass_until ${windowLabel}`,
        );
      } else {
        await updateTaskStatus(
          taskId,
          'cancelled',
          `L2 rejected: reject_until ${windowLabel}`,
        );
      }

      await finalizeDecision(
        decisionId,
        isPass ? 'pass' : 'reject',
        resolvedBy,
        decision,
      );
      await forwardToDaemon(taskId, decisionId, action, command, timeInput);

      return Response.json({
        success: true,
        data: {
          taskId,
          decision: action,
          message: `${emoji} 已${verb}，${scopeLabel}同类操作将自动${verb}。`,
        },
      });
    }

    return Response.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 },
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

/**
 * Resolve or deny the Web-side decision. Falls back to a noop if the
 * decision is no longer in the cache (already expired / swept) — the
 * daemon-side forward is still attempted so the agent loop unblocks.
 */
async function finalizeDecision(
  decisionId: string,
  action: 'pass' | 'reject',
  resolvedBy: string,
  decision: ReturnType<ReturnType<typeof getDecisionQueue>['get']> | null,
): Promise<void> {
  if (!decision) {
    logger.warn('decision not in cache; skipping queue resolve', {
      decisionId,
    });
    return;
  }
  try {
    if (action === 'reject') {
      await getDecisionQueue().deny(decisionId, resolvedBy);
    } else {
      await getDecisionQueue().resolve(decisionId, action, resolvedBy);
    }
  } catch (err) {
    logger.error('queue resolve failed', {
      decisionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Forward the verdict to the daemon so its agent loop unblocks and its
 * L2AuthManager records the pattern cache entry (for pass_until /
 * reject_until). Errors are logged but do not fail the request — the
 * decision is already recorded on the Web side, and the daemon will
 * time out on its own if the forward truly cannot land.
 */
async function forwardToDaemon(
  taskId: string,
  decisionId: string,
  action: string,
  pattern: string,
  duration: string,
): Promise<void> {
  try {
    await forwardL2Confirm({
      task_id: taskId,
      decision_id: decisionId,
      action,
      pattern,
      duration,
    });
  } catch (err) {
    logger.warn('forward to daemon failed; decision still recorded', {
      taskId,
      decisionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function formatWindowLabel(timeInput: string): string {
  const hh = Number.parseInt(timeInput.slice(0, 2), 10);
  const dd = Number.parseInt(timeInput.slice(2, 4), 10);
  const mm = Number.parseInt(timeInput.slice(4, 6), 10);
  const yy = Number.parseInt(timeInput.slice(6, 8), 10);
  const parts: string[] = [];
  if (yy > 0) parts.push(`${yy}年`);
  if (mm > 0) parts.push(`${mm}月`);
  if (dd > 0) parts.push(`${dd}天`);
  if (hh > 0) parts.push(`${hh}小时`);
  return parts.length > 0 ? parts.join('') : '立即';
}
