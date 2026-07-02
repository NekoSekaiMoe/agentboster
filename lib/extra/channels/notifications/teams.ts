import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.teams');

interface TeamsConfig {
  appId: string;
  appPassword: string;
}

/**
 * Microsoft Teams notification channel (via Bot Framework).
 *
 * Auth flow: exchange the Azure AD app's appId + appPassword for a
 * Bot Framework token (client_credentials grant against the
 * `https://api.botframework.com/.default` scope), then post to the
 * Bot Framework `v3/conversations/{conversationId}/activities`
 * endpoint.
 *
 * targetChatId is the Bot Framework conversation reference, encoded
 * as `conversationId` optionally followed by `|serviceUrl`
 * (e.g. `19:meeting_xxx@thread.skype|https://smba.trafficmanager.net/teams/`).
 * The serviceUrl defaults to the public Teams endpoint if omitted.
 */
export class TeamsNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'teams';
  private config: TeamsConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: TeamsConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return !!this.config.appId && !!this.config.appPassword;
  }

  private async getToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.appId,
      client_secret: this.config.appPassword,
      scope: 'https://api.botframework.com/.default',
    });

    const resp = await fetch(
      `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`azure oauth error: ${resp.status} ${text}`);
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
      const token = await this.getToken();
      if (!token) {
        throw new Error('could not obtain bot framework access token');
      }

      // targetChatId encodes conversationId and optional serviceUrl.
      const [conversationId, serviceUrl] = targetChatId.split('|');
      const base = (
        serviceUrl ?? 'https://smba.trafficmanager.net/teams/'
      ).replace(/\/$/, '');

      const text = this.renderText(payload);
      const body = {
        type: 'message',
        text,
        textFormat: 'markdown',
      };

      const resp = await fetch(
        `${base}/v3/conversations/${conversationId}/activities`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`teams api error: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as { id?: string };
      return {
        success: true,
        channel: this.type,
        messageId: data.id ?? '',
      };
    } catch (error) {
      logger.error('teams send failed', {
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
