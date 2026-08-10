import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from '../notification-channel';
import type {
  DecisionNotification,
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
    const locale: Locale = payload.locale ?? defaultLocale;
    if (payload.type === 'decision') {
      return {
        text: `⚠️ ${payload.title}: ${payload.command}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `⚠️ ${payload.title}` },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `${t(locale, 'notify.field.task')}: ${payload.body}`,
                `${t(locale, 'notify.field.command')}: \`${payload.command}\``,
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
          {
            type: 'actions',
            elements: this.buildDecisionActions(payload),
          },
        ],
      };
    }

    if (payload.type === 'l2_time_input') {
      return {
        text: payload.promptMessage,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: payload.promptMessage },
          },
        ],
      };
    }

    if (payload.type === 'workspace_failover') {
      const fields: Array<Record<string, unknown>> = [];
      if (payload.details?.migratedAt)
        fields.push({
          type: 'mrkdwn',
          text: `*${t(locale, 'notify.workspaceFailover.migratedAt')}:* ${payload.details.migratedAt}`,
        });
      return {
        text: `⚠️ ${payload.title}: ${payload.summary}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `⚠️ ${payload.title}` },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: payload.summary },
          },
          ...(fields.length > 0 ? [{ type: 'section', fields }] : []),
        ],
      };
    }

    const emoji = this.statusEmoji(payload.status);
    const fields: Array<Record<string, unknown>> = [];

    if (payload.details) {
      if (payload.details.subAgents)
        fields.push({
          type: 'mrkdwn',
          text: `*${t(locale, 'notify.field.subAgents')}:* ${payload.details.subAgents}`,
        });
      if (payload.details.filesChanged)
        fields.push({
          type: 'mrkdwn',
          text: `*${t(locale, 'notify.field.filesChanged')}:* ${payload.details.filesChanged}`,
        });
      if (payload.details.commits)
        fields.push({
          type: 'mrkdwn',
          text: `*${t(locale, 'notify.field.commits')}:* ${payload.details.commits}`,
        });
      if (payload.details.logsUrl)
        fields.push({
          type: 'mrkdwn',
          text: `<${payload.details.logsUrl}|${t(locale, 'notify.field.viewLogs')}>`,
        });
      if (payload.details.error)
        fields.push({
          type: 'mrkdwn',
          text: `*${t(locale, 'notify.field.error')}:* ${payload.details.error}`,
        });
      if (payload.details.pending && payload.details.pending.length > 0)
        fields.push({
          type: 'mrkdwn',
          text: `📝 *${t(locale, 'notify.field.pending')}:*\n${payload.details.pending.map((i) => `• ${i}`).join('\n')}`,
        });
      if (payload.details.knownIssues && payload.details.knownIssues.length > 0)
        fields.push({
          type: 'mrkdwn',
          text: `⚠️ *${t(locale, 'notify.field.knownIssues')}:*\n${payload.details.knownIssues.map((i) => `• ${i}`).join('\n')}`,
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

  private buildDecisionActions(
    payload: DecisionNotification,
  ): Array<Record<string, unknown>> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const taskId = payload.taskId;
    const decisionId = payload.decisionId;

    return [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: `✅ ${t(locale, 'notify.l2.passOnce')}`,
        },
        action_id: `l2:pass_once:${taskId}:${decisionId}`,
        style: 'primary',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: `⏱ ${t(locale, 'notify.l2.passUntil')}`,
        },
        action_id: `l2:pass_until:${taskId}:${decisionId}`,
        style: 'primary',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
        },
        action_id: `l2:reject_once:${taskId}:${decisionId}`,
        style: 'danger',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
        },
        action_id: `l2:reject_until:${taskId}:${decisionId}`,
        style: 'danger',
      },
    ];
  }

  private statusEmoji(status: string): string {
    return status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
  }
}
