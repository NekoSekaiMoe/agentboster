import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.feishu');

interface FeishuConfig {
  appId: string;
  appSecret: string;
  webhookUrl?: string;
}

export class FeishuNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'feishu' as AdapterName;
  private config: FeishuConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return !!this.config.appId && !!this.config.appSecret;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const response = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const data = (await response.json()) as {
      tenant_access_token?: string;
      code?: number;
    };

    if (!data.tenant_access_token) {
      throw new Error(`Feishu token error: ${data.code}`);
    }

    this.accessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
    return this.accessToken;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const card = this.renderPayload(payload);

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await this.getAccessToken()}`,
          },
          body: JSON.stringify({
            receive_id: targetChatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Feishu API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        code: number;
        msg: string;
        data?: { message_id?: string };
      };

      if (data.code !== 0) {
        throw new Error(`Feishu API error: ${data.code} ${data.msg}`);
      }

      return {
        success: true,
        channel: this.type,
        messageId: data.data?.message_id,
      };
    } catch (error) {
      logger.error('feishu send failed', {
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
    if (b.type === 'event_callback' && typeof b.event === 'object') {
      const event = b.event as Record<string, unknown>;
      if (event.type === 'message' && typeof event.text === 'string') {
        const text = event.text.trim();
        const validPrefixes = [
          'l2:pass_once',
          'l2:pass_until',
          'l2:reject_once',
          'l2:reject_until',
          'always',
        ];
        for (const prefix of validPrefixes) {
          if (text.startsWith(prefix)) return text;
        }
      }
    }
    return null;
  }

  private renderPayload(payload: NotificationPayload): Record<string, unknown> {
    const locale: Locale = payload.locale ?? defaultLocale;
    if (payload.type === 'decision') {
      const taskId = payload.taskId;
      const decisionId = payload.decisionId;

      return {
        header: {
          title: { tag: 'plain_text', content: `⚠️ ${payload.title}` },
          template: 'orange',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: [
                `${t(locale, 'notify.field.task')}: ${payload.body}`,
                `${t(locale, 'notify.field.command')}: ${payload.command}`,
                ...(payload.commandReview
                  ? [
                      `${t(locale, 'notify.field.commandReview')}:\n${payload.commandReview}`,
                    ]
                  : []),
                `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
                `${t(locale, 'notify.field.reason')}: ${payload.reason}`,
              ].join('\n'),
            },
          },
          { tag: 'hr' },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: {
                  tag: 'lark_md',
                  content: `✅ ${t(locale, 'notify.l2.passOnce')}`,
                },
                type: 'default',
                value: { action: `l2:pass_once:${taskId}:${decisionId}` },
              },
              {
                tag: 'button',
                text: {
                  tag: 'lark_md',
                  content: `⏱ ${t(locale, 'notify.l2.passUntil')}`,
                },
                type: 'default',
                value: { action: `l2:pass_until:${taskId}:${decisionId}` },
              },
            ],
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: {
                  tag: 'lark_md',
                  content: `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
                },
                type: 'danger',
                value: { action: `l2:reject_once:${taskId}:${decisionId}` },
              },
              {
                tag: 'button',
                text: {
                  tag: 'lark_md',
                  content: `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
                },
                type: 'danger',
                value: { action: `l2:reject_until:${taskId}:${decisionId}` },
              },
            ],
          },
        ],
      };
    }

    if (payload.type === 'l2_time_input') {
      return {
        header: {
          title: {
            tag: 'plain_text',
            content: t(locale, 'notify.timeInput.placeholder'),
          },
          template: 'orange',
        },
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: payload.promptMessage },
          },
        ],
      };
    }

    if (payload.type === 'workspace_failover') {
      const locale: Locale = payload.locale ?? defaultLocale;
      const elements: Array<Record<string, unknown>> = [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: payload.summary },
        },
      ];
      if (payload.details?.migratedAt) {
        elements.push({ tag: 'hr' });
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${t(locale, 'notify.workspaceFailover.migratedAt')}:** ${payload.details.migratedAt}`,
          },
        });
      }
      return {
        header: {
          title: { tag: 'plain_text', content: `⚠️ ${payload.title}` },
          template: 'orange',
        },
        elements,
      };
    }

    const color =
      payload.status === 'completed'
        ? 'green'
        : payload.status === 'failed'
          ? 'red'
          : 'grey';

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: payload.summary },
      },
    ];

    if (payload.details) {
      elements.push({ tag: 'hr' });
      const fields: string[] = [];
      if (payload.details.subAgents)
        fields.push(
          `**${t(locale, 'notify.field.subAgents')}:** ${payload.details.subAgents}`,
        );
      if (payload.details.filesChanged)
        fields.push(
          `**${t(locale, 'notify.field.filesChanged')}:** ${payload.details.filesChanged}`,
        );
      if (payload.details.commits)
        fields.push(
          `**${t(locale, 'notify.field.commits')}:** ${payload.details.commits}`,
        );
      if (payload.details.logsUrl)
        fields.push(
          `[${t(locale, 'notify.field.viewLogs')}](${payload.details.logsUrl})`,
        );
      if (payload.details.error)
        fields.push(
          `**${t(locale, 'notify.field.error')}:** ${payload.details.error}`,
        );
      if (payload.details.pending && payload.details.pending.length > 0) {
        const items = payload.details.pending.map((i) => `• ${i}`).join('\n');
        fields.push(`📝 **${t(locale, 'notify.field.pending')}:**\n${items}`);
      }
      if (
        payload.details.knownIssues &&
        payload.details.knownIssues.length > 0
      ) {
        const items = payload.details.knownIssues
          .map((i) => `• ${i}`)
          .join('\n');
        fields.push(
          `⚠️ **${t(locale, 'notify.field.knownIssues')}:**\n${items}`,
        );
      }

      if (fields.length > 0) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: fields.join('\n') },
        });
      }
    }

    return {
      header: {
        title: {
          tag: 'plain_text',
          content: `${this.statusEmoji(payload.status)} ${payload.title}`,
        },
        template: color,
      },
      elements,
    };
  }

  private statusEmoji(status: string): string {
    return status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
  }
}
