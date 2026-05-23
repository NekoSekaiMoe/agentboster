import { getKV } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from './notification-channel';
import type {
  ChannelHealth,
  NotificationPayload,
  NotificationSendResult,
} from './notification-types';

const logger = createLogger('notification-manager');

// ─── Retry config ────────────────────────────────────────────────────

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff, max 5 retries
const FAILURE_THRESHOLD = 3; // consecutive failures before channel marked unhealthy
const DEDUP_TTL = 300; // 5 minutes dedup window in seconds

// ─── Notification Manager ────────────────────────────────────────────

class NotificationManager {
  private channels = new Map<string, NotificationChannel>();
  private channelHealth = new Map<string, ChannelHealth>();
  private kv: ReturnType<typeof getKV> | null = null;

  constructor() {
    this.kv = getKV();
  }

  // ── Channel Registration ──────────────────────────────────────────

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

  // ── Health Management ────────────────────────────────────────────

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

  // ── Deduplication (Asika delivery_id pattern) ────────────────────

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

  // ── Send with Retry + Fallback ───────────────────────────────────

  /**
   * Send a notification through the preferred channel.
   * If the preferred channel fails, automatically tries fallback channels.
   * Uses exponential backoff retry (Asika Webhook Retry pattern).
   */
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

    // Build channel order: preferred first, then fallbacks
    const channelOrder = [
      preferredChannel,
      ...fallbackChannels.filter((c) => c !== preferredChannel),
    ];

    for (const channelType of channelOrder) {
      // Skip unhealthy channels (unless it's the last option)
      const health = this.channelHealth.get(channelType);
      const isLastChannel =
        channelType === channelOrder[channelOrder.length - 1];
      if (health && !health.healthy && !isLastChannel) {
        logger.info('skipping unhealthy channel', { channel: channelType });
        continue;
      }

      // Check dedup
      if (await this.isDuplicate(taskId, notificationType, channelType)) {
        logger.info('duplicate notification skipped', {
          taskId,
          type: notificationType,
          channel: channelType,
        });
        return { success: true, channel: channelType };
      }

      // Try to send with retry
      const channel = this.channels.get(channelType);
      if (!channel) {
        logger.warn('channel not registered', { channel: channelType });
        continue;
      }

      const result = await this.sendWithRetry(channel, targetChatId, payload);

      if (result.success) {
        await this.markSent(taskId, notificationType, channelType);
        this.updateHealth(channelType, true);
        return result;
      }

      // Channel failed — record failure and try next
      this.updateHealth(channelType, false, result.error);
      logger.warn('channel send failed, trying fallback', {
        channel: channelType,
        error: result.error,
        taskId,
      });
    }

    // All channels failed
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

// ─── Singleton ──────────────────────────────────────────────────────

let instance: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}
