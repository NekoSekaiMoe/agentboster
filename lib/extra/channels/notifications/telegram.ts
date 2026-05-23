import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.telegram');

interface TelegramConfig {
  botToken: string;
}

export class TelegramNotificationChannel implements NotificationChannel {
  readonly type = 'telegram';
  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return !!this.config.botToken;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const text = this.renderPayload(payload);

      const body: Record<string, unknown> = {
        chat_id: targetChatId,
        text,
        parse_mode: 'Markdown',
      };

      // For decision notifications, add inline keyboard
      if (payload.type === 'decision') {
        body.reply_markup = {
          inline_keyboard: this.buildDecisionKeyboard(payload),
        };
      }

      const response = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as {
        ok: boolean;
        result?: { message_id: number };
      };

      if (!data.ok) {
        throw new Error('Telegram API returned ok=false');
      }

      return {
        success: true,
        channel: this.type,
        messageId: String(data.result?.message_id),
      };
    } catch (error) {
      logger.error('telegram send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        channel: this.type,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  parseDecisionReply(body: unknown): string | null {
    // Handle callback_query from inline keyboard
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if ('callback_query' in b) {
      const cq = b.callback_query as Record<string, unknown>;
      if ('data' in cq && typeof cq.data === 'string') {
        return cq.data; // returns the option like "once", "10min", etc.
      }
    }
    return null;
  }

  private renderPayload(payload: NotificationPayload): string {
    if (payload.type === 'decision') {
      return [
        `⚠️ *${this.escape(payload.title)}*`,
        ``,
        `\`${payload.body}\``,
        ``,
        `风险评分: ${payload.options.length > 0 ? '需要确认' : ''}`,
        `过期时间: ${payload.expiresAt}`,
      ].join('\n');
    }

    // Completion notification
    const statusEmoji =
      payload.status === 'completed'
        ? '✅'
        : payload.status === 'failed'
          ? '❌'
          : '⏹️';
    const lines = [
      `${statusEmoji} *${this.escape(payload.title)}*`,
      ``,
      this.escape(payload.summary),
    ];

    if (payload.details) {
      lines.push(``);
      if (payload.details.subAgents)
        lines.push(`子 Agent: ${payload.details.subAgents}`);
      if (payload.details.filesChanged)
        lines.push(`文件变更: ${payload.details.filesChanged}`);
      if (payload.details.commits)
        lines.push(`提交数: ${payload.details.commits}`);
      if (payload.details.logsUrl)
        lines.push(`[查看日志](${payload.details.logsUrl})`);
      if (payload.details.error)
        lines.push(`错误: ${this.escape(payload.details.error)}`);
    }

    return lines.join('\n');
  }

  private buildDecisionKeyboard(
    payload: NotificationPayload,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const options = payload.options;
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

    // Split into rows of 3
    for (let i = 0; i < options.length; i += 3) {
      const row = options.slice(i, i + 3).map((opt) => ({
        text: this.optionLabel(opt),
        callback_data: opt,
      }));
      keyboard.push(row);
    }

    return keyboard;
  }

  private optionLabel(option: string): string {
    const labels: Record<string, string> = {
      once: '✅ 仅此次',
      '10min': '⏱️ 10分钟',
      '1hour': '🕐 1小时',
      '1day': '📅 今天',
      always: '♾️ 会话内',
      reject: '❌ 拒绝',
    };
    return labels[option] || option;
  }

  private escape(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
