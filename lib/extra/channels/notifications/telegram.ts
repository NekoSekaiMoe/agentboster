import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
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
    const locale: Locale = payload.locale ?? defaultLocale;
    if (payload.type === 'decision') {
      return [
        `⚠️ *${this.escape(payload.title)}*`,
        ``,
        `${t(locale, 'notify.field.task')}: ${this.escape(payload.body)}`,
        `${t(locale, 'notify.field.command')}: \`${this.escape(payload.command)}\``,
        ...(payload.commandReview
          ? [
              `${t(locale, 'notify.field.commandReview')}:\n${this.escape(payload.commandReview)}`,
            ]
          : []),
        `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
        `${t(locale, 'notify.field.reason')}: ${this.escape(payload.reason)}`,
        ``,
        t(locale, 'notify.field.selectAction'),
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
        lines.push(
          `${t(locale, 'notify.field.subAgents')}: ${payload.details.subAgents}`,
        );
      if (payload.details.filesChanged)
        lines.push(
          `${t(locale, 'notify.field.filesChanged')}: ${payload.details.filesChanged}`,
        );
      if (payload.details.commits)
        lines.push(
          `${t(locale, 'notify.field.commits')}: ${payload.details.commits}`,
        );
      if (payload.details.logsUrl)
        lines.push(
          `[${t(locale, 'notify.field.viewLogs')}](${payload.details.logsUrl})`,
        );
      if (payload.details.error)
        lines.push(
          `${t(locale, 'notify.field.error')}: ${this.escape(payload.details.error)}`,
        );
      if (payload.details.pending && payload.details.pending.length > 0) {
        lines.push('', `📝 ${t(locale, 'notify.field.pending')}:`);
        for (const item of payload.details.pending)
          lines.push(`  • ${this.escape(item)}`);
      }
      if (
        payload.details.knownIssues &&
        payload.details.knownIssues.length > 0
      ) {
        lines.push('', `⚠️ ${t(locale, 'notify.field.knownIssues')}:`);
        for (const issue of payload.details.knownIssues)
          lines.push(`  • ${this.escape(issue)}`);
      }
    }

    return lines.join('\n');
  }

  private buildDecisionKeyboard(
    payload: DecisionNotification,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const taskId = payload.taskId;
    const decisionId = payload.decisionId;

    return [
      [
        {
          text: `✅ ${t(locale, 'notify.l2.passOnce')}`,
          callback_data: `l2:pass_once:${taskId}:${decisionId}`,
        },
        {
          text: `⏱ ${t(locale, 'notify.l2.passUntil')}`,
          callback_data: `l2:pass_until:${taskId}:${decisionId}`,
        },
      ],
      [
        {
          text: `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
          callback_data: `l2:reject_once:${taskId}:${decisionId}`,
        },
        {
          text: `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
          callback_data: `l2:reject_until:${taskId}:${decisionId}`,
        },
      ],
    ];
  }

  private escape(text: string): string {
    return text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
}
