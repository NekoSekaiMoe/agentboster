import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  CompletionNotification,
  DecisionNotification,
  L2TimeInputNotification,
  NotificationPayload,
  NotificationSendResult,
  WorkspaceFailoverNotification,
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
 * cross-client reliability. L2 decisions are sent as interactive
 * `template_card` (text_notice with button_list); the inbound
 * `template_card_event` path in callback/route.ts routes the click to
 * `processL2Decision`.
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

      // L2 decision → interactive template_card (text_notice with button_list).
      // The inbound handler at callback/route.ts (template_card_event) reads
      // event.CardItem.Value, which WeCom sets to the clicked button's `key`.
      // task_id is required and echoed back as event.TaskId so the host can
      // correlate (we don't currently use it, but the API rejects the card
      // without it).
      const body =
        payload.type === 'decision'
          ? this.buildDecisionCardBody(targetChatId, payload)
          : {
              touser: targetChatId,
              msgtype: 'text' as const,
              agentid: Number.parseInt(this.config.agentId, 10),
              text: { content: this.renderText(payload) },
            };

      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
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

  private renderText(
    payload:
      | CompletionNotification
      | L2TimeInputNotification
      | WorkspaceFailoverNotification,
  ): string {
    if (payload.type === 'l2_time_input') {
      return payload.promptMessage;
    }
    if (payload.type === 'workspace_failover') {
      const migratedAt = payload.details?.migratedAt
        ? `\n\nMigrated at: ${payload.details.migratedAt}`
        : '';
      return `⚠️ 【${payload.title}】\n\n${payload.summary}${migratedAt}`;
    }

    const emoji =
      payload.status === 'completed'
        ? '✅'
        : payload.status === 'failed'
          ? '❌'
          : '⏹️';
    return `${emoji} 【${payload.title}】\n\n${payload.summary}`;
  }

  /**
   * Build a WeCom template_card (text_notice) body for an L2 decision.
   *
   * The card carries the verdict context (command/score/reason) in
   * source.desc + main_title + emphasis, plus a button_list whose `key`
   * is the canonical `l2:<action>:<taskId>:<decisionId>` payload. When
   * the user taps a button WeCom fires a `template_card_event` inbound
   * webhook with `event.CardItem.Value === key` — handled in
   * callback/route.ts.
   *
   * Reference: qyapi.weixin.qq.com/cgi-bin/message/send doc,
   * msgtype = "template_card", card_type = "text_notice".
   */
  private buildDecisionCardBody(
    targetChatId: string,
    payload: DecisionNotification,
  ): Record<string, unknown> {
    const locale: Locale = payload.locale ?? defaultLocale;

    type DecisionAction =
      | 'pass_once'
      | 'pass_until'
      | 'reject_once'
      | 'reject_until';
    const actions: { action: DecisionAction; label: string }[] = [
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

    const buttons = actions.map(({ action, label }) => ({
      text: label,
      style: action.startsWith('reject') ? 2 : 1,
      key: `l2:${action}:${payload.taskId}:${payload.decisionId}`,
    }));

    return {
      touser: targetChatId,
      msgtype: 'template_card',
      agentid: Number.parseInt(this.config.agentId, 10),
      template_card: {
        card_type: 'text_notice',
        source: {
          desc: `${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}`,
        },
        main_title: {
          title: payload.title,
          desc: payload.body,
        },
        emphasis_content: {
          title: payload.score.toFixed(1),
          desc: t(locale, 'notify.field.score'),
        },
        sub_title_text: `${t(locale, 'notify.field.command')}: ${payload.command}\n${t(locale, 'notify.field.reason')}: ${payload.reason}`,
        task_id: `${payload.taskId}:${payload.decisionId}`,
        button_list: buttons,
      },
    };
  }
}
