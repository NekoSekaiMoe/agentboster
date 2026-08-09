import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  DecisionNotification,
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.discord');

interface DiscordConfig {
  botToken: string;
}

export class DiscordNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'discord' as AdapterName;
  private config: DiscordConfig;

  constructor(config: DiscordConfig) {
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
      const body = this.buildBody(payload);

      const response = await fetch(
        `https://discord.com/api/v10/channels/${targetChatId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${this.config.botToken}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Discord API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as { id: string };

      return {
        success: true,
        channel: this.type,
        messageId: data.id,
      };
    } catch (error) {
      logger.error('discord send failed', {
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
    if (b.type === 3 && typeof b.data === 'object') {
      const data = b.data as Record<string, unknown>;
      if (typeof data.custom_id === 'string') {
        return data.custom_id;
      }
    }
    return null;
  }

  private buildBody(payload: NotificationPayload): Record<string, unknown> {
    const locale: Locale = payload.locale ?? defaultLocale;
    if (payload.type === 'decision') {
      return {
        embeds: [
          {
            title: `⚠️ ${payload.title}`,
            description: [
              `${t(locale, 'notify.field.task')}: ${payload.body}`,
              `${t(locale, 'notify.field.command')}: \`${payload.command}\``,
              ...(payload.commandReview
                ? [
                    `${t(locale, 'notify.field.commandReview')}:\n${payload.commandReview}`,
                  ]
                : []),
              `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
              `${t(locale, 'notify.field.reason')}: ${payload.reason}`,
              ``,
              t(locale, 'notify.field.selectAction'),
            ].join('\n'),
            color: 0xffa500,
            timestamp: new Date().toISOString(),
          },
        ],
        components: this.buildDecisionComponents(payload),
      };
    }

    if (payload.type === 'l2_time_input') {
      return {
        content: payload.promptMessage,
      };
    }

    if (payload.type === 'workspace_failover') {
      const fields: Array<{ name: string; value: string; inline?: boolean }> =
        [];
      if (payload.details?.migratedAt)
        fields.push({
          name: 'Migrated at',
          value: payload.details.migratedAt,
        });
      return {
        embeds: [
          {
            title: `⚠️ ${payload.title}`,
            description: payload.summary,
            color: 0xffa500,
            fields: fields.length > 0 ? fields : undefined,
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const color =
      payload.status === 'completed'
        ? 0x00ff00
        : payload.status === 'failed'
          ? 0xff0000
          : 0x808080;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    if (payload.details) {
      if (payload.details.subAgents)
        fields.push({
          name: t(locale, 'notify.field.subAgents'),
          value: String(payload.details.subAgents),
          inline: true,
        });
      if (payload.details.filesChanged)
        fields.push({
          name: t(locale, 'notify.field.filesChanged'),
          value: String(payload.details.filesChanged),
          inline: true,
        });
      if (payload.details.commits)
        fields.push({
          name: t(locale, 'notify.field.commits'),
          value: String(payload.details.commits),
          inline: true,
        });
      if (payload.details.logsUrl)
        fields.push({
          name: t(locale, 'notify.field.viewLogs'),
          value: `[${t(locale, 'notify.field.viewLogs')}](${payload.details.logsUrl})`,
        });
      if (payload.details.error)
        fields.push({
          name: t(locale, 'notify.field.error'),
          value: payload.details.error,
        });
      if (payload.details.pending && payload.details.pending.length > 0)
        fields.push({
          name: `📝 ${t(locale, 'notify.field.pending')}`,
          value: payload.details.pending.map((i) => `• ${i}`).join('\n'),
        });
      if (payload.details.knownIssues && payload.details.knownIssues.length > 0)
        fields.push({
          name: `⚠️ ${t(locale, 'notify.field.knownIssues')}`,
          value: payload.details.knownIssues.map((i) => `• ${i}`).join('\n'),
        });
    }

    return {
      embeds: [
        {
          title: `${this.statusEmoji(payload.status)} ${payload.title}`,
          description: payload.summary,
          color,
          fields: fields.length > 0 ? fields : undefined,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private buildDecisionComponents(
    payload: DecisionNotification,
  ): Array<Record<string, unknown>> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const taskId = payload.taskId;
    const decisionId = payload.decisionId;

    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1, // primary (blue)
            label: t(locale, 'notify.l2.passOnce'),
            custom_id: `l2:pass_once:${taskId}:${decisionId}`,
          },
          {
            type: 2,
            style: 1, // primary (blue)
            label: t(locale, 'notify.l2.passUntil'),
            custom_id: `l2:pass_until:${taskId}:${decisionId}`,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4, // danger (red)
            label: t(locale, 'notify.l2.rejectOnce'),
            custom_id: `l2:reject_once:${taskId}:${decisionId}`,
          },
          {
            type: 2,
            style: 4, // danger (red)
            label: t(locale, 'notify.l2.rejectUntil'),
            custom_id: `l2:reject_until:${taskId}:${decisionId}`,
          },
        ],
      },
    ];
  }

  private statusEmoji(status: string): string {
    return status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
  }
}
