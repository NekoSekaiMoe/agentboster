import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.slack');

interface SlackConfig {
  botToken: string;
}

interface SlackRenderResult {
  blocks: Array<Record<string, unknown>>;
  text: string;
}

export class SlackNotificationChannel implements NotificationChannel {
  readonly type = 'slack';
  private config: SlackConfig;

  constructor(config: SlackConfig) {
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
      const { blocks, text } = this.renderPayload(payload);

      const body: Record<string, unknown> = {
        channel: targetChatId,
        text,
        blocks,
      };

      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        ok: boolean;
        ts?: string;
        error?: string;
      };

      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`);
      }

      return {
        success: true,
        channel: this.type,
        messageId: data.ts,
      };
    } catch (error) {
      logger.error('slack send failed', {
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
    if (b.type === 'block_actions' && Array.isArray(b.actions)) {
      const action = b.actions[0] as Record<string, unknown>;
      if (typeof action.action_id === 'string') {
        return action.action_id;
      }
    }
    return null;
  }

  private renderPayload(payload: NotificationPayload): SlackRenderResult {
    if (payload.type === 'decision') {
      return {
        text: `⚠️ ${payload.title}: ${payload.body}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `⚠️ ${payload.title}` },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: payload.body },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*过期时间:* ${payload.expiresAt}` },
          },
          {
            type: 'actions',
            elements: payload.options.map((option) => ({
              type: 'button',
              text: { type: 'plain_text', text: this.optionLabel(option) },
              action_id: option,
              style: option === 'reject' ? 'danger' : undefined,
            })),
          },
        ],
      };
    }

    // Completion notification
    const emoji = this.statusEmoji(payload.status);
    const fields: Array<Record<string, unknown>> = [];

    if (payload.details) {
      if (payload.details.subAgents)
        fields.push({
          type: 'mrkdwn',
          text: `*子 Agent:* ${payload.details.subAgents}`,
        });
      if (payload.details.filesChanged)
        fields.push({
          type: 'mrkdwn',
          text: `*文件变更:* ${payload.details.filesChanged}`,
        });
      if (payload.details.commits)
        fields.push({
          type: 'mrkdwn',
          text: `*提交数:* ${payload.details.commits}`,
        });
      if (payload.details.logsUrl)
        fields.push({
          type: 'mrkdwn',
          text: `<${payload.details.logsUrl}|查看日志>`,
        });
      if (payload.details.error)
        fields.push({
          type: 'mrkdwn',
          text: `*错误:* ${payload.details.error}`,
        });
    }

    return {
      text: `${emoji} ${payload.title}: ${payload.summary}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${payload.title}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: payload.summary },
        },
        ...(fields.length > 0 ? [{ type: 'section', fields }] : []),
      ],
    };
  }

  private optionLabel(option: string): string {
    const labels: Record<string, string> = {
      once: '仅此次',
      '10min': '10分钟',
      '1hour': '1小时',
      '1day': '今天',
      always: '会话内',
      reject: '拒绝',
    };
    return labels[option] || option;
  }

  private statusEmoji(status: string): string {
    return status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
  }
}
