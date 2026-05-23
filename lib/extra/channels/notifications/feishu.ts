import { createLogger } from '@/lib/utils/logger';
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
  readonly type = 'feishu';
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
    this.tokenExpiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
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
        // Check if text matches a decision option
        const validOptions = [
          'once',
          '10min',
          '1hour',
          '1day',
          'always',
          'reject',
        ];
        if (validOptions.includes(text)) return text;
      }
    }
    return null;
  }

  private renderPayload(payload: NotificationPayload): Record<string, unknown> {
    if (payload.type === 'decision') {
      return {
        header: {
          title: { tag: 'plain_text', content: `⚠️ ${payload.title}` },
          template: 'orange',
        },
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: payload.body },
          },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**过期时间:** ${payload.expiresAt}`,
            },
          },
          {
            tag: 'hr',
          },
          {
            tag: 'action',
            actions: payload.options.map((option) => ({
              tag: 'button',
              text: { tag: 'lark_md', content: this.optionLabel(option) },
              type: option === 'reject' ? 'danger' : 'default',
              value: { action: option },
            })),
          },
        ],
      };
    }

    // Completion notification
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
        fields.push(`**子 Agent:** ${payload.details.subAgents}`);
      if (payload.details.filesChanged)
        fields.push(`**文件变更:** ${payload.details.filesChanged}`);
      if (payload.details.commits)
        fields.push(`**提交数:** ${payload.details.commits}`);
      if (payload.details.logsUrl)
        fields.push(`[点击查看日志](${payload.details.logsUrl})`);
      if (payload.details.error)
        fields.push(`**错误:** ${payload.details.error}`);

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

  private statusEmoji(status: string): string {
    return status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
  }
}
