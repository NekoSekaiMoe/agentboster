import { createLogger } from '@/lib/utils/logger';
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
  readonly type = 'discord';
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
    if (payload.type === 'decision') {
      return {
        embeds: [
          {
            title: `⚠️ ${payload.title}`,
            description: [
              `任务：${payload.body}`,
              `命令：\`${payload.command}\``,
              `风险评分：${payload.score.toFixed(1)}/1.0`,
              `原因：${payload.reason}`,
              ``,
              `请选择：`,
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
          name: '子 Agent',
          value: String(payload.details.subAgents),
          inline: true,
        });
      if (payload.details.filesChanged)
        fields.push({
          name: '文件变更',
          value: String(payload.details.filesChanged),
          inline: true,
        });
      if (payload.details.commits)
        fields.push({
          name: '提交数',
          value: String(payload.details.commits),
          inline: true,
        });
      if (payload.details.logsUrl)
        fields.push({
          name: '日志',
          value: `[点击查看](${payload.details.logsUrl})`,
        });
      if (payload.details.error)
        fields.push({ name: '错误', value: payload.details.error });
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
    const taskId = payload.taskId;
    const decisionId = payload.decisionId;

    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1, // primary (blue)
            label: 'pass once',
            custom_id: `l2:pass_once:${taskId}:${decisionId}`,
          },
          {
            type: 2,
            style: 1, // primary (blue)
            label: 'pass until...',
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
            label: 'reject once',
            custom_id: `l2:reject_once:${taskId}:${decisionId}`,
          },
          {
            type: 2,
            style: 4, // danger (red)
            label: 'reject until...',
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
