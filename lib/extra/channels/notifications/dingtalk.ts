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
 * pure plaintext send — no crypto needed (unlike WeCom/feishu). L2
 * decisions use the `sampleActionCard` msgKey with embedded btns whose
 * id carries the canonical `l2:` payload; clicks come back as inbound
 * `msgtype: 'actionCard'` events (handled in callback/route.ts).
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

      // L2 decision → interactive sampleActionCard. The card carries btns
      // whose id is the canonical `l2:<action>:<taskId>:<decisionId>`
      // payload; when the user taps a button the inbound webhook fires
      // with msgtype === 'actionCard' and actionCardAction.actionBtnId
      // set to that id, dispatched in handleDingtalkWebhook.
      const isDecision = payload.type === 'decision';
      const content = isDecision
        ? this.renderDecisionCardText(payload)
        : this.renderText(payload);
      const isMarkdown = !isDecision && /[*_`#\-[\]]/.test(content);
      const msgKey = isDecision
        ? 'sampleActionCard'
        : isMarkdown
          ? 'sampleMarkdown'
          : 'sampleText';
      const msgParam = isDecision
        ? this.buildDecisionMsgParam(payload)
        : isMarkdown
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
        ? `\n\n_Migrated at: ${payload.details.migratedAt}_`
        : '';
      return `⚠️ **${payload.title}**\n\n${payload.summary}${migratedAt}`;
    }

    const emoji =
      payload.status === 'completed'
        ? '✅'
        : payload.status === 'failed'
          ? '❌'
          : '⏹️';
    return `${emoji} **${payload.title}**\n\n${payload.summary}`;
  }

  /**
   * Body text for the sampleActionCard. Markdown is supported inside
   * actionCard text, so we keep the verdict context as a bulleted
   * summary. The buttons (rendered separately via buildDecisionMsgParam)
   * carry the L2 payload, not the text.
   */
  private renderDecisionCardText(payload: DecisionNotification): string {
    const locale: Locale = payload.locale ?? defaultLocale;
    return [
      `**${payload.body}**`,
      '',
      `- ${t(locale, 'notify.field.command')}: \`${payload.command}\``,
      `- ${t(locale, 'notify.field.score')}: ${payload.score.toFixed(1)}/1.0`,
      `- ${t(locale, 'notify.field.reason')}: ${payload.reason}`,
    ].join('\n');
  }

  /**
   * Build msgParam for sampleActionCard. DingTalk robot's actionCard
   * supports a `btns` array; each entry's `title` is the visible label
   * and `id` is echoed back as actionCardAction.actionBtnId on the
   * inbound click event. We embed the canonical L2 payload there.
   */
  private buildDecisionMsgParam(payload: DecisionNotification): string {
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
    return JSON.stringify({
      title: payload.title,
      text: this.renderDecisionCardText(payload),
      btns: actions.map(({ action, label }) => ({
        title: label,
        id: `l2:${action}:${payload.taskId}:${payload.decisionId}`,
      })),
    });
  }
}
