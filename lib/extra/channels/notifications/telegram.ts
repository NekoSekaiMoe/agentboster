import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from '../notification-channel';
import type {
  DecisionNotification,
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
      const body: Record<string, unknown> = {
        chat_id: targetChatId,
        text: this.renderText(payload),
        parse_mode: 'Markdown',
      };

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
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if ('callback_query' in b) {
      const cq = b.callback_query as Record<string, unknown>;
      if ('data' in cq && typeof cq.data === 'string') {
        return cq.data;
      }
    }
    return null;
  }

  private renderText(payload: NotificationPayload): string {
    if (payload.type === 'decision') {
      return [
        `⚠️ *${this.escape(payload.title)}*`,
        ``,
        `任务：${this.escape(payload.body)}`,
        `命令：\`${this.escape(payload.command)}\``,
        ...(payload.commandReview
          ? [`命令审查：\n${this.escape(payload.commandReview)}`]
          : []),
        `风险评分：${payload.score.toFixed(1)}/1.0`,
        `原因：${this.escape(payload.reason)}`,
        ``,
        `请选择：`,
      ].join('\n');
    }

    if (payload.type === 'l2_time_input') {
      return payload.promptMessage;
    }

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
      lines.push('');
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
    payload: DecisionNotification,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const taskId = payload.taskId;
    const decisionId = payload.decisionId;

    return [
      [
        {
          text: '✅ pass once',
          callback_data: `l2:pass_once:${taskId}:${decisionId}`,
        },
        {
          text: '⏱ pass until...',
          callback_data: `l2:pass_until:${taskId}:${decisionId}`,
        },
      ],
      [
        {
          text: '❌ reject once',
          callback_data: `l2:reject_once:${taskId}:${decisionId}`,
        },
        {
          text: '🔕 reject until...',
          callback_data: `l2:reject_until:${taskId}:${decisionId}`,
        },
      ],
    ];
  }

  private escape(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
