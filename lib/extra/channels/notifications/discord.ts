import { createLogger } from '@/lib/utils/logger';
import type { NotificationChannel } from '../notification-channel';
import type {
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
      const { embed, components } = this.renderPayload(payload);

      const body: Record<string, unknown> = { embeds: [embed] };

      // For decision notifications, add action row with buttons
      if (payload.type === 'decision' && components.length > 0) {
        body.components = components;
      }

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

  private renderPayload(payload: NotificationPayload): {
    embed: Record<string, unknown>;
    components: Array<Record<string, unknown>>;
  } {
    if (payload.type === 'decision') {
      return {
        embed: {
          title: `⚠️ ${payload.title}`,
          description: payload.body,
          color: 0xffa500, // orange
          fields: [
            { name: '过期时间', value: payload.expiresAt, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
        components: [this.buildDecisionActionRow(payload)],
      };
    }

    // Completion notification
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
      embed: {
        title: `${this.statusEmoji(payload.status)} ${payload.title}`,
        description: payload.summary,
        color,
        fields: fields.length > 0 ? fields : undefined,
        timestamp: new Date().toISOString(),
      },
      components: [],
    };
  }

  private buildDecisionActionRow(
    payload: NotificationPayload,
  ): Record<string, unknown> {
    const buttons = payload.options.map((option) => ({
      type: 2, // button
      style: option === 'reject' ? 4 : 1, // red for reject, blue for others
      label: this.optionLabel(option),
      custom_id: option,
    }));

    return {
      type: 1, // action row
      components: buttons.slice(0, 5), // Discord limits 5 buttons per row
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
