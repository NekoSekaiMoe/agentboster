import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.wecom');

interface WecomConfig {
  corpId: string;
  secret: string;
  agentId: string;
}

/**
 * WeCom (企业微信) application-messaging notification channel.
 *
 * Uses the application-messaging API (qyapi.weixin.qq.com/cgi-bin/message/send),
 * NOT the smart-bot reply API. The push notifications (L2 decisions, task
 * completion) are single-direction — there's no inbound ResponseCode to
 * satisfy the aibot/response contract. Application messaging works with
 * just access_token + agent_id + touser.
 *
 * Quota: account_size × 200 msgs/day per app, 30/min and 1000/hour per
 * recipient (per WeCom doc 90236). For L2 decisions this is plenty.
 *
 * targetChatId is the WeCom user id (From.UserId from inbound). Group
 * chats would need appchat/send + chatid (not implemented).
 *
 * Markdown is supported via the `markdown` msgtype but rendering varies
 * between mobile and desktop clients; we send plain text for
 * cross-client reliability. Rich L2 buttons would require
 * template_card with text_notice card_type, which the user can tap to
 * trigger a callback — not yet implemented because the L2 button
 * payload needs the same AES-encrypted callback path as inbound
 * messages, and the simpler text prompt is workable.
 */
export class WecomNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'wecom';
  private config: WecomConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: WecomConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return (
      !!this.config.corpId && !!this.config.secret && !!this.config.agentId
    );
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.secret)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`wecom gettoken http error: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };
    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(
        `wecom gettoken: ${data.errcode} ${data.errmsg ?? 'no token'}`,
      );
    }
    this.cachedToken = data.access_token;
    this.tokenExpiresAt =
      Date.now() + (data.expires_in ?? 7200) * 1000 - 60_000;
    return this.cachedToken;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        throw new Error('could not obtain wecom access token');
      }

      const content = this.renderText(payload);
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            touser: targetChatId,
            msgtype: 'text',
            agentid: Number.parseInt(this.config.agentId, 10),
            text: { content },
          }),
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`wecom api error: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as {
        errcode?: number;
        errmsg?: string;
        msgid?: string;
      };
      if (data.errcode !== 0) {
        throw new Error(
          `wecom api error: ${data.errcode} ${data.errmsg ?? ''}`,
        );
      }

      return {
        success: true,
        channel: this.type,
        messageId: data.msgid,
      };
    } catch (error) {
      logger.error('wecom send failed', {
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
        `【${payload.title}】`,
        ``,
        `${t(locale, 'notify.field.task')}: ${payload.body}`,
        `${t(locale, 'notify.field.command')}: ${payload.command}`,
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
    return `${emoji} 【${payload.title}】\n\n${payload.summary}`;
  }
}
