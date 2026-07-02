import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.qq');

interface QQConfig {
  appId: string;
  appSecret: string;
}

/**
 * QQ Official Bot notification channel.
 *
 * Auth flow: exchange appId + appSecret for a QQ access_token at
 * `https://bots.qq.com/app/getAppAccessToken`, then post to the
 * channel-message or message-create endpoint.
 *
 * targetChatId is the channel id (for guild channels) — QQ bot API
 * addresses messages per channel. The send path uses the v2 Open API.
 */
export class QQNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'qq';
  private config: QQConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: QQConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return !!this.config.appId && !!this.config.appSecret;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.config.appId,
        clientSecret: this.config.appSecret,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`qq oauth error: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.cachedToken;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        throw new Error('could not obtain qq access token');
      }

      const content = this.renderText(payload);

      const resp = await fetch(
        `https://api.sgroup.qq.com/channels/${targetChatId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${token}`,
          },
          body: JSON.stringify({ content }),
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`qq api error: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as { id?: string };
      return {
        success: true,
        channel: this.type,
        messageId: data.id ?? '',
      };
    } catch (error) {
      logger.error('qq send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        channel: this.type,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private renderText(payload: NotificationPayload): string {
    const locale: Locale = payload.locale ?? defaultLocale;
    if (payload.type === 'decision') {
      return [
        `**${payload.title}**`,
        ``,
        `${t(locale, 'notify.field.task')}: ${payload.body}`,
        `${t(locale, 'notify.field.command')}: \`${payload.command}\``,
        `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
        `${t(locale, 'notify.field.reason')}: ${payload.reason}`,
        ``,
        t(locale, 'notify.field.selectAction'),
      ].join('\n');
    }

    if (payload.type === 'l2_time_input') {
      return payload.promptMessage;
    }

    const emoji =
      payload.status === 'completed'
        ? '✅'
        : payload.status === 'failed'
          ? '❌'
          : '⏹️';
    return `${emoji} **${payload.title}**\n\n${payload.summary}`;
  }
}
