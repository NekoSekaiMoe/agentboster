import type {
  NotificationPayload,
  NotificationSendResult,
} from './notification-types';

/**
 * NotificationChannel interface — each IM channel implements this.
 * Replicates Asika's Notifier interface pattern (Type() + Send()).
 */
export interface NotificationChannel {
  /** Channel identifier (e.g., 'telegram', 'discord', 'slack', 'feishu') */
  readonly type: string;

  /** Whether the channel is connected and ready */
  isHealthy(): boolean;

  /**
   * Send a notification to the target chat/user.
   * Each channel renders the unified payload into platform-specific format.
   */
  send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult>;

  /**
   * Parse user reply from webhook (for L2 decision responses).
   * Returns the selected option or null if not a decision reply.
   */
  parseDecisionReply?(body: unknown): string | null;
}
