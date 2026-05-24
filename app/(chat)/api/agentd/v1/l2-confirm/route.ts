import { updateTaskStatus } from '@/lib/core/db/agentd';
import { getKV } from '@/lib/core/kv';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';
import { createLogger } from '@/lib/utils/logger';

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
    const kv = getKV();

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

    // ── Handle pass_once ──────────────────────────────────────────────
    if (action === 'pass_once') {
      await mgr.markDecisionProcessed(decisionId);
      await updateTaskStatus(taskId, 'running', 'L2 authorized: pass_once');

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
      // Check if this is the initial button click (no timeInput) or the time input response
      if (!timeInput) {
        // First click — send time input prompt
        const ctx = mgr.getL2Context(decisionId);
        const command = ctx?.taskId ? ctx.taskId : 'unknown';

        // Get user's preferred channel from notification preferences
        const prefs = userId
          ? await import('@/lib/core/db/notification').then((m) =>
              m.getNotificationPreferences(userId),
            )
          : null;
        const channel = prefs?.preferredChannel ?? 'telegram';

        // Send time input prompt via notification channel
        await mgr.sendL2TimeInputPrompt({
          taskId,
          decisionId,
          action,
          command,
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

      // Calculate expiry
      let expiresAt: Date;
      let windowLabel: string;

      if (timeInput === 'always') {
        expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        windowLabel = '本次会话内';
      } else {
        const hh = Number.parseInt(timeInput.slice(0, 2), 10);
        const dd = Number.parseInt(timeInput.slice(2, 4), 10);
        const mm = Number.parseInt(timeInput.slice(4, 6), 10);
        const yy = Number.parseInt(timeInput.slice(6, 8), 10);

        const ttlMs =
          hh * 60 * 60 * 1000 +
          dd * 24 * 60 * 60 * 1000 +
          mm * 30 * 24 * 60 * 60 * 1000 +
          yy * 365 * 24 * 60 * 60 * 1000;

        expiresAt = new Date(Date.now() + ttlMs);
        windowLabel = formatWindowLabel(hh, dd, mm, yy);
      }

      // Store authorization in KV
      const authKey = `l2:auth:${taskId}:${chatId}`;
      await kv.set(
        authKey,
        JSON.stringify({
          action: action === 'pass_until' ? 'pass' : 'reject',
          taskId,
          decisionId,
          chatId,
          userId,
          expiresAt: expiresAt.toISOString(),
          decidedAt: new Date().toISOString(),
        }),
        { ex: Math.floor((expiresAt.getTime() - Date.now()) / 1000) },
      );

      await mgr.markDecisionProcessed(decisionId);

      const isPass = action === 'pass_until';
      const emoji = isPass ? '✅' : '🔕';
      const verb = isPass ? '放行' : '拒绝';

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

      return Response.json({
        success: true,
        data: {
          taskId,
          decision: action,
          expiresAt: expiresAt.toISOString(),
          message: `${emoji} 已${verb}至 ${windowLabel}。${isPass ? '在此之前同类操作将自动放行，不再询问。' : '在此之前同类操作将自动拒绝，不再通知。'}`,
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

function formatWindowLabel(
  hh: number,
  dd: number,
  mm: number,
  yy: number,
): string {
  const parts: string[] = [];
  if (yy > 0) parts.push(`${yy}年`);
  if (mm > 0) parts.push(`${mm}月`);
  if (dd > 0) parts.push(`${dd}天`);
  if (hh > 0) parts.push(`${hh}小时`);
  return parts.length > 0 ? parts.join('') : '立即';
}
