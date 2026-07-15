/**
 * L2 decision processing — the shared core behind the
 * /api/agentd/v1/l2-confirm route and the bot.onAction catch-all in
 * lib/bot/index.ts.
 *
 * Extracted out of the route file because Next.js route modules must
 * only export HTTP verbs (GET/POST/...). Exporting processL2Decision
 * from the route breaks the route-types validator (.next/types/...).
 * Both the HTTP route and the IM bot action handler import this module
 * directly so there's no internal HTTP round-trip when a user taps an
 * L2 button in an IM client.
 */

import { forwardL2Confirm } from '@/lib/extra/agent/agentd-client';
import { updateTaskStatus } from '@/lib/core/db/agentd';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';
import { ensureNotificationChannels } from '@/lib/extra/channels/register-channels';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { createLogger } from '@/lib/utils/logger';
import { getConfig } from '@/lib/core/kv/config';

const logger = createLogger('l2-decision');

const DURATION_RE = /^(always|\d{8})$/;

/**
 * Outcome of processing an L2 decision. Returned by processL2Decision
 * so the HTTP route can shape the Response and the bot action handler
 * can decide whether to ACK silently.
 */
export interface L2DecisionOutcome {
  success: boolean;
  status: number;
  awaitingTimeInput?: boolean;
  message?: string;
  error?: string;
}

/**
 * Process an L2 decision. Performs dedup, updates task status, resolves
 * the Web-side DecisionQueue entry, forwards the verdict to the daemon,
 * and sends any follow-up IM notification (e.g. the pass_until time
 * input prompt).
 */
export async function processL2Decision(input: {
  taskId: string;
  decisionId: string;
  action: string;
  timeInput?: string | null;
  chatId?: string | null;
  userId?: string | null;
}): Promise<L2DecisionOutcome> {
  const { taskId, decisionId, action } = input;
  const timeInput = input.timeInput ?? null;
  const chatId = input.chatId ?? null;
  const userId = input.userId ?? null;

  if (!taskId || !decisionId || !action) {
    return {
      success: false,
      status: 400,
      error: 'Missing required fields: taskId, decisionId, action',
    };
  }

  const mgr = getNotificationManager();
  const config = await getConfig();
  ensureNotificationChannels(config);

  const alreadyProcessed = await mgr.isDecisionProcessed(decisionId);
  if (alreadyProcessed) {
    logger.info('L2 decision already processed (dedup)', {
      taskId,
      decisionId,
      action,
    });
    return {
      success: true,
      status: 200,
      message: 'Already processed.',
    };
  }

  logger.info('L2 confirmation received', {
    taskId,
    decisionId,
    action,
    timeInput,
    chatId,
    userId,
  });

  const queue = getDecisionQueue();
  const decision = queue.get(decisionId);
  const resolvedBy = userId ?? 'im-user';
  const ctx = mgr.getL2Context(decisionId);
  const command = decision?.command ?? ctx?.taskId ?? taskId;

  // ── pass_once ──────────────────────────────────────────────────
  if (action === 'pass_once') {
    await mgr.markDecisionProcessed(decisionId);
    await updateTaskStatus(taskId, 'running', 'L2 authorized: pass_once');
    await finalizeDecision(decisionId, 'pass', resolvedBy, decision);
    await forwardToDaemon(
      taskId,
      decisionId,
      'pass_once',
      command,
      'once',
      decision?.nodeId,
    );
    return {
      success: true,
      status: 200,
      message: '✅ 已放行。任务继续执行。',
    };
  }

  // ── reject_once ────────────────────────────────────────────────
  if (action === 'reject_once') {
    await mgr.markDecisionProcessed(decisionId);
    await updateTaskStatus(
      taskId,
      'cancelled',
      'Rejected by user via L2 authorization (reject_once)',
    );
    await finalizeDecision(decisionId, 'reject', resolvedBy, decision);
    await forwardToDaemon(
      taskId,
      decisionId,
      'reject_once',
      command,
      'once',
      decision?.nodeId,
    );
    return {
      success: true,
      status: 200,
      message: '❌ 已拒绝。任务已取消。',
    };
  }

  // ── pass_until / reject_until — Step 1: prompt for time ────────
  if (action === 'pass_until' || action === 'reject_until') {
    if (!timeInput) {
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
        targetChatId: chatId ?? '',
      });
      return {
        success: true,
        status: 200,
        awaitingTimeInput: true,
        message: '⏱️ 请回复时间。格式：hhddmmyy 或 always。',
      };
    }

    if (!DURATION_RE.test(timeInput)) {
      return {
        success: false,
        status: 400,
        error:
          '⚠️ 格式错误。请输入 8 位数字（hhddmmyy）或 always。`01000000`=1小时，`00010000`=1天',
      };
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
    await forwardToDaemon(
      taskId,
      decisionId,
      action,
      command,
      timeInput,
      decision?.nodeId,
    );
    return {
      success: true,
      status: 200,
      message: `${emoji} 已${verb}，${scopeLabel}同类操作将自动${verb}。`,
    };
  }

  return {
    success: false,
    status: 400,
    error: `Unknown action: ${action}`,
  };
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
  nodeId?: string,
): Promise<void> {
  try {
    await forwardL2Confirm({
      task_id: taskId,
      decision_id: decisionId,
      action,
      pattern,
      duration,
      nodeId,
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
