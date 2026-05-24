import { getKV } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from './notification-channel';
import type {
  ChannelHealth,
  L2DecisionContext,
  NotificationPayload,
  NotificationSendResult,
} from './notification-types';

const logger = createLogger('notification-manager');

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
const FAILURE_THRESHOLD = 3;
const DEDUP_TTL = 300;
const L2_TIMEOUT_MS = 3 * 60 * 1000;
const ESCALATION_TIMEOUT_MS = 5 * 60 * 1000;

class NotificationManager {
  private channels = new Map<string, NotificationChannel>();
  private channelHealth = new Map<string, ChannelHealth>();
  private kv: ReturnType<typeof getKV> | null = null;
  private l2Contexts = new Map<string, L2DecisionContext>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();

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
      channel: type as AdapterName,
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
    await this.kv.set(key, '1', { ex: DEDUP_TTL });
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
    // Clear any escalation timer
    const timer = this.escalationTimers.get(decisionId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(decisionId);
    }
  }

  async isDecisionProcessed(decisionId: string): Promise<boolean> {
    if (!this.kv) return false;
    const key = `l2:decision:${decisionId}`;
    const existing = await this.kv.get(key);
    return existing !== null;
  }

  async markDecisionProcessed(decisionId: string): Promise<void> {
    if (!this.kv) return;
    const key = `l2:decision:${decisionId}`;
    await this.kv.set(key, '1', { ex: 3600 });
  }

  // ── User Online Detection ───────────────────────────────────────────

  async markUserOnline(userId: string): Promise<void> {
    if (!this.kv) return;
    await this.kv.set(`user:online:${userId}`, Date.now().toString(), { ex: 86400 });
  }

  async isUserOnline(userId: string): Promise<boolean> {
    if (!this.kv) return true; // assume online if no KV
    const lastSeen = await this.kv.get<string>(`user:online:${userId}`);
    if (!lastSeen) return false;
    const lastMs = Number.parseInt(lastSeen, 10);
    // Consider online if seen within last 5 minutes
    return Date.now() - lastMs < 5 * 60 * 1000;
  }

  // ── L2 Decision Send with Multi-Channel Fallback + Timeout ──────────

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
      targetUserId,
    } = params;

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

    let sentChannels: string[] = [];

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
        sentChannels.push(channelType);

        // If user is online on this channel, no need to escalate
        if (targetUserId) {
          await this.markUserOnline(targetUserId);
        }

        // Set up escalation timer for this decision
        this.setupEscalationTimer(decisionId, taskId, payload, channelOrder, sentChannels, targetChatId, targetUserId);

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
      channel: (channelOrder[channelOrder.length - 1] ?? 'slack') as AdapterName,
      error: 'All notification channels failed for L2 decision',
    };
  }

  // ── Escalation Timer: 3min → fallback IM, 5min → suspend ───────────

  private setupEscalationTimer(
    decisionId: string,
    taskId: string,
    payload: NotificationPayload,
    channelOrder: string[],
    alreadySentChannels: string[],
    targetChatId: string,
    targetUserId?: string,
  ): void {
    // Clear existing timer
    const existing = this.escalationTimers.get(decisionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      // Check if decision was already resolved
      const processed = await this.isDecisionProcessed(decisionId);
      if (processed) return;

      logger.warn('L2 decision escalation: no response after 3min', {
        decisionId,
        taskId,
        sentChannels: alreadySentChannels,
      });

      // Try remaining channels not yet tried
      const remainingChannels = channelOrder.filter(
        (c) => !alreadySentChannels.includes(c),
      );

      for (const channelType of remainingChannels) {
        const channel = this.channels.get(channelType);
        if (!channel) continue;

        const health = this.channelHealth.get(channelType);
        if (health && !health.healthy) continue;

        const result = await this.sendWithRetry(channel, targetChatId, payload);
        if (result.success) {
          logger.info('L2 decision escalated to fallback channel', {
            decisionId,
            channel: channelType,
          });
          alreadySentChannels.push(channelType);

          // Set final 5-minute suspend timer
          this.setupSuspendTimer(decisionId, taskId, alreadySentChannels, targetChatId, targetUserId);
          return;
        }
      }

      // All channels exhausted — set suspend timer
      this.setupSuspendTimer(decisionId, taskId, alreadySentChannels, targetChatId, targetUserId);
    }, L2_TIMEOUT_MS);

    this.escalationTimers.set(decisionId, timer);
  }

  private setupSuspendTimer(
    decisionId: string,
    taskId: string,
    sentChannels: string[],
    targetChatId: string,
    targetUserId?: string,
  ): void {
    const remainingMs = ESCALATION_TIMEOUT_MS - L2_TIMEOUT_MS;

    const timer = setTimeout(async () => {
      const processed = await this.isDecisionProcessed(decisionId);
      if (processed) return;

      logger.warn('L2 decision suspended: no response after 5min', {
        decisionId,
        taskId,
        sentChannels,
      });

      // Mark decision as timed out in KV
      if (this.kv) {
        await this.kv.set(
          `l2:decision:${decisionId}:status`,
          'timeout',
          { ex: 3600 },
        );
      }

      // Send timeout notification to all channels that received the original
      const timeoutPayload: NotificationPayload = {
        type: 'decision',
        taskId,
        decisionId,
        title: '⏰ 决策已超时',
        body: '任务已暂停，等待您重新上线后处理。',
        command: '',
        score: 0,
        reason: 'timeout',
        options: [],
        expiresAt: new Date(0).toISOString(),
      };

      for (const channelType of sentChannels) {
        const channel = this.channels.get(channelType);
        if (channel) {
          await channel.send(targetChatId, timeoutPayload).catch(() => {});
        }
      }
    }, remainingMs);

    this.escalationTimers.set(`${decisionId}:suspend`, timer);
  }

  // ── Reactivate Pending Decisions (user came online) ─────────────────

  async reactivatePendingDecisions(
    pendingDecisions: Array<{
      decisionId: string;
      taskId: string;
      command: string;
      score: number;
      reason: string;
      sessionID?: string;
    }>,
    preferredChannel: string,
    fallbackChannels: string[],
    targetChatId: string,
    targetUserId?: string,
  ): Promise<void> {
    for (const d of pendingDecisions) {
      const processed = await this.isDecisionProcessed(d.decisionId);
      if (processed) continue;

      logger.info('Reactivating pending decision', {
        decisionId: d.decisionId,
        taskId: d.taskId,
      });

      await this.sendL2Decision({
        taskId: d.taskId,
        decisionId: d.decisionId,
        title: '⚠️ 高风险操作需要您的授权（重新发送）',
        body: d.command,
        command: d.command,
        score: d.score,
        reason: d.reason,
        preferredChannel,
        fallbackChannels,
        targetChatId,
        targetUserId,
      });
    }
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
      return { success: false, channel: channel as AdapterName, error: 'Channel not registered' };
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
        return { success: true, channel: channelType as AdapterName };
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
      channel: channelOrder[channelOrder.length - 1] as AdapterName,
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

    return { success: false, channel: channel.type as AdapterName, error: lastError };
  }
}

let instance: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}
