import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { signL2Link } from '@/lib/security/l2-link';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  CompletionNotification,
  DecisionNotification,
  L2TimeInputNotification,
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

      const content =
        payload.type === 'decision'
          ? await this.renderDecision(payload)
          : this.renderText(payload);

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

  // L2 decisions on QQ are rendered as markdown links rather than
  // callback buttons. QQ's keyboard/button API requires per-bot
  // "button permission" approval from Tencent (gate we can't satisfy
  // programmatically), and QQ doesn't go through chat-sdk so the
  // bot.onAction catch-all wouldn't fire anyway. Each link points at
  // the public /api/l2/<decisionId>/<action> route with an HMAC
  // signature (lib/security/l2-link.ts); clicking opens a minimal
  // confirmation page in QQ's in-app browser. Any IM client that
  // supports markdown links (which is all of them) gets a working
  // decision UX without platform-specific button permission.

  private renderText(
    payload: CompletionNotification | L2TimeInputNotification,
  ): string {
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

  private async renderDecision(payload: DecisionNotification): Promise<string> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const actions: { action: string; label: string }[] = [
      { action: 'pass_once', label: `✅ ${t(locale, 'notify.l2.passOnce')}` },
      {
        action: 'pass_until',
        label: `⏱ ${t(locale, 'notify.l2.passUntil')}`,
      },
      {
        action: 'reject_once',
        label: `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
      },
      {
        action: 'reject_until',
        label: `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
      },
    ];

    const origin = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const lines = await Promise.all(
      actions.map(async ({ action, label }) => {
        const { params } = await signL2Link({
          decisionId: payload.decisionId,
          action,
        });
        const url = `${origin}/api/l2/${payload.decisionId}/${action}?${params}`;
        return `- [${label}](${url})`;
      }),
    );

    return [
      `**${payload.title}**`,
      '',
      `${t(locale, 'notify.field.task')}: ${payload.body}`,
      `${t(locale, 'notify.field.command')}: \`${payload.command}\``,
      `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
      `${t(locale, 'notify.field.reason')}: ${payload.reason}`,
      '',
      t(locale, 'notify.field.selectAction'),
      ...lines,
    ].join('\n');
  }
}
