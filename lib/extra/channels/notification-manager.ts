import { getKV } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from './notification-channel';
import type {
  ChannelHealth,
  L2Action,
  L2DecisionContext,
  NotificationPayload,
  NotificationSendResult,
} from './notification-types';

const logger = createLogger('notification-manager');

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
const FAILURE_THRESHOLD = 3;
const DEDUP_TTL = 300;
const L2_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes for L2 response

class NotificationManager {
  private channels = new Map<string, NotificationChannel>();
  private channelHealth = new Map<string, ChannelHealth>();
  private kv: ReturnType<typeof getKV> | null = null;
  private l2Contexts = new Map<string, L2DecisionContext>(); // key = decisionId

  constructor() {
    this.kv = getKV();
  }

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.type, channel);
    logger.info('notification channel registered', { type: channel.type });
  }

  getChannel(type: string): NotificationChannel | undefined {
    return this.channels.get(type);
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.channels.keys());
  }

  getChannelHealth(type: string): ChannelHealth | undefined {
    return this.channelHealth.get(type);
  }

  getAllChannelHealth(): ChannelHealth[] {
    return Array.from(this.channelHealth.values());
  }

  private updateHealth(type: string, success: boolean, error?: string): void {
    const existing = this.channelHealth.get(type);
    const consecutiveFailures = success
      ? 0
      : (existing?.consecutiveFailures ?? 0) + 1;
    const healthy = consecutiveFailures < FAILURE_THRESHOLD;

    this.channelHealth.set(type, {
      channel: type,
      consecutiveFailures,
      lastError: error,
      lastSuccessAt: success
        ? new Date().toISOString()
        : existing?.lastSuccessAt,
      lastFailureAt: !success
        ? new Date().toISOString()
        : existing?.lastFailureAt,
      healthy,
    });

    if (!healthy) {
      logger.warn('channel marked unhealthy', { type, consecutiveFailures });
    }
  }

  private dedupKey(taskId: string, type: string, channel: string): string {
    return `notif:dedup:${taskId}:${type}:${channel}`;
  }

  async isDuplicate(
    taskId: string,
    type: string,
    channel: string,
  ): Promise<boolean> {
    if (!this.kv) return false;
    const key = this.dedupKey(taskId, type, channel);
    const existing = await this.kv.get(key);
    return existing !== null;
  }

  async markSent(taskId: string, type: string, channel: string): Promise<void> {
    if (!this.kv) return;
    const key = this.dedupKey(taskId, type, channel);
    await this.kv.set(key, '1', DEDUP_TTL);
  }

  // ── L2 Decision Context Management ─────────────────────────────────

  getL2Context(decisionId: string): L2DecisionContext | undefined {
    return this.l2Contexts.get(decisionId);
  }

  setL2Context(decisionId: string, ctx: L2DecisionContext): void {
    this.l2Contexts.set(decisionId, ctx);
  }

  removeL2Context(decisionId: string): void {
    this.l2Contexts.delete(decisionId);
  }

  // Check if a decision has been processed (dedup across IM channels)
  async isDecisionProcessed(decisionId: string): Promise<boolean> {
    if (!this.kv) return false;
    const key = `l2:decision:${decisionId}`;
    const existing = await this.kv.get(key);
    return existing !== null;
  }

  async markDecisionProcessed(decisionId: string): Promise<void> {
    if (!this.kv) return;
    const key = `l2:decision:${decisionId}`;
    await this.kv.set(key, '1', 3600); // 1 hour TTL
  }

  // ── L2 Decision Send with Multi-Channel Fallback ───────────────────

  async sendL2Decision(params: {
    taskId: string;
    decisionId: string;
    title: string;
    body: string;
    command: string;
    score: number;
    reason: string;
    preferredChannel: string;
    fallbackChannels: string[];
    targetChatId: string;
    targetUserId?: string;
  }): Promise<NotificationSendResult> {
    const {
      taskId,
      decisionId,
      title,
      body,
      command,
      score,
      reason,
      preferredChannel,
      fallbackChannels,
      targetChatId,
    } = params;

    // Store L2 context for this decision
    this.setL2Context(decisionId, {
      action: 'pass_once',
      taskId,
      decisionId,
      awaitingTimeInput: false,
      createdAt: new Date().toISOString(),
    });

    const payload: NotificationPayload = {
      type: 'decision',
      taskId,
      decisionId,
      title,
      body,
      command,
      score,
      reason,
      options: ['pass_once', 'pass_until', 'reject_once', 'reject_until'],
      expiresAt: new Date(Date.now() + L2_TIMEOUT_MS).toISOString(),
    };

    // Try preferred channel first, then fallbacks
    const channelOrder = [
      preferredChannel,
      ...fallbackChannels.filter((c) => c !== preferredChannel),
    ];

    for (const channelType of channelOrder) {
      const health = this.channelHealth.get(channelType);
      const isLastChannel =
        channelType === channelOrder[channelOrder.length - 1];
      if (health && !health.healthy && !isLastChannel) {
        logger.info('skipping unhealthy channel for L2', { channel: channelType });
        continue;
      }

      const channel = this.channels.get(channelType);
      if (!channel) continue;

      const result = await this.sendWithRetry(channel, targetChatId, payload);

      if (result.success) {
        this.updateHealth(channelType, true);
        return result;
      }

      this.updateHealth(channelType, false, result.error);
      logger.warn('L2 channel failed, trying fallback', {
        channel: channelType,
        error: result.error,
        taskId,
      });
    }

    return {
      success: false,
      channel: channelOrder[channelOrder.length - 1],
      error: 'All notification channels failed for L2 decision',
    };
  }

  // ── L2 Time Input Prompt ───────────────────────────────────────────

  async sendL2TimeInputPrompt(params: {
    taskId: string;
    decisionId: string;
    action: 'pass_until' | 'reject_until';
    command: string;
    channel: string;
    targetChatId: string;
  }): Promise<NotificationSendResult> {
    const { taskId, decisionId, action, command, channel, targetChatId } = params;

    // Update context to awaiting time input
    const ctx = this.l2Contexts.get(decisionId);
    if (ctx) {
      ctx.awaitingTimeInput = true;
      ctx.action = action;
    }

    const actionLabel = action === 'pass_until' ? '放行' : '拒绝';

    const promptMessage = [
      `⏱️ 请回复时间`,
      ``,
      `您选择对 \`${command}\` ${actionLabel}至指定时间。`,
      ``,
      `格式：hhddmmyy（时-日-月-年，不足两位补零）`,
      `或输入 always = 本次会话有效`,
      ``,
      `示例：`,
      `\`01000000\` = 1小时`,
      `\`00010000\` = 1天`,
      `\`00000100\` = 1月`,
      `always  = 本次会话内有效`,
    ].join('\n');

    const payload: NotificationPayload = {
      type: 'l2_time_input',
      taskId,
      decisionId,
      action,
      title: '⏱ 请输入时间',
      command,
      promptMessage,
    };

    const ch = this.channels.get(channel);
    if (!ch) {
      return { success: false, channel, error: 'Channel not registered' };
    }

    return this.sendWithRetry(ch, targetChatId, payload);
  }

  // ── Send with Retry + Fallback ─────────────────────────────────────

  async send(params: {
    taskId: string;
    notificationType: string;
    payload: NotificationPayload;
    preferredChannel: string;
    fallbackChannels: string[];
    targetChatId: string;
    targetUserId?: string;
  }): Promise<NotificationSendResult> {
    const {
      taskId,
      notificationType,
      payload,
      preferredChannel,
      fallbackChannels,
      targetChatId,
    } = params;

    const channelOrder = [
      preferredChannel,
      ...fallbackChannels.filter((c) => c !== preferredChannel),
    ];

    for (const channelType of channelOrder) {
      const health = this.channelHealth.get(channelType);
      const isLastChannel =
        channelType === channelOrder[channelOrder.length - 1];
      if (health && !health.healthy && !isLastChannel) {
        logger.info('skipping unhealthy channel', { channel: channelType });
        continue;
      }

      if (await this.isDuplicate(taskId, notificationType, channelType)) {
        logger.info('duplicate notification skipped', {
          taskId,
          type: notificationType,
          channel: channelType,
        });
        return { success: true, channel: channelType };
      }

      const channel = this.channels.get(channelType);
      if (!channel) continue;

      const result = await this.sendWithRetry(channel, targetChatId, payload);

      if (result.success) {
        await this.markSent(taskId, notificationType, channelType);
        this.updateHealth(channelType, true);
        return result;
      }

      this.updateHealth(channelType, false, result.error);
      logger.warn('channel send failed, trying fallback', {
        channel: channelType,
        error: result.error,
        taskId,
      });
    }

    return {
      success: false,
      channel: channelOrder[channelOrder.length - 1],
      error: 'All notification channels failed',
    };
  }

  private async sendWithRetry(
    channel: NotificationChannel,
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const result = await channel.send(targetChatId, payload);
        if (result.success) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        logger.info('retrying notification send', {
          channel: channel.type,
          attempt: attempt + 1,
          delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return { success: false, channel: channel.type, error: lastError };
  }
}

let instance: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}
