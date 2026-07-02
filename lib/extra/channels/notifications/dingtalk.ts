import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.dingtalk');

interface DingtalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
}

/**
 * DingTalk (钉钉) notification channel for L2 decisions / task pushes.
 *
 * Uses the OpenAPI robot send endpoints (same as DingtalkBotAdapter):
 *   - Single chat: POST /v1.0/robot/oToMessages/batchSend
 *   - Group chat:  POST /v1.0/robot/groupMessages/send
 *
 * targetChatId convention mirrors the adapter: threadId with `single:` or
 * `group:` prefix. Without a prefix, single-chat is assumed.
 *
 * DingTalk has no editMessage/deleteMessage for already-sent messages,
 * and the inbound webhook doesn't encrypt payloads (only HMAC-SHA256 sign
 * verify in headers, handled in callback/route.ts). So this channel is
 * pure plaintext send — no crypto needed (unlike WeCom/feishu).
 *
 * Quota: there is a daily send-volume cap; when exceeded, the inbound
 * webhook starts including an errorMessage field and text.content is
 * omitted. Receiving that signal requires inspection of subsequent
 * inbound payloads, which the adapter doesn't do — suffice to say heavy
 * L2 notification volume may hit limits faster than the OpenAPI allows.
 */
export class DingtalkNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'dingtalk';
  private config: DingtalkConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: DingtalkConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return (
      !!this.config.appKey && !!this.config.appSecret && !!this.config.robotCode
    );
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    const resp = await fetch(
      'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appKey: this.config.appKey,
          appSecret: this.config.appSecret,
        }),
      },
    );
    if (!resp.ok) {
      throw new Error(`dingtalk oauth http error: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      accessToken?: string;
      expireIn?: number;
    };
    if (!data.accessToken) {
      throw new Error('dingtalk: no accessToken in response');
    }
    this.cachedToken = data.accessToken;
    this.tokenExpiresAt = Date.now() + (data.expireIn ?? 7200) * 1000 - 60_000;
    return this.cachedToken;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        throw new Error('could not obtain dingtalk access token');
      }

      const content = this.renderText(payload);
      const isMarkdown = /[*_`#\-[\]]/.test(content);
      const msgKey = isMarkdown ? 'sampleMarkdown' : 'sampleText';
      const msgParam = isMarkdown
        ? JSON.stringify({ title: payload.title ?? 'Agent', text: content })
        : JSON.stringify({ content });

      const isGroup = targetChatId.startsWith('group:');
      const conversationId = isGroup
        ? targetChatId.slice('group:'.length)
        : targetChatId.startsWith('single:')
          ? targetChatId.slice('single:'.length)
          : targetChatId;

      const endpoint = isGroup
        ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
        : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

      const body = isGroup
        ? {
            msgParam,
            msgKey,
            openConversationId: conversationId,
            robotCode: this.config.robotCode,
          }
        : {
            msgParam,
            msgKey,
            robotCode: this.config.robotCode,
            userIds: [conversationId],
          };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`dingtalk api error: ${resp.status} ${text}`);
      }
      const data = (await resp.json()) as {
        code?: number;
        message?: string;
        processQueryKey?: string;
      };
      if (data.code !== undefined && data.code !== 0) {
        throw new Error(
          `dingtalk api error: ${data.code} ${data.message ?? ''}`,
        );
      }

      return {
        success: true,
        channel: this.type,
        messageId: data.processQueryKey,
      };
    } catch (error) {
      logger.error('dingtalk send failed', {
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
