import { defaultLocale, type Locale } from '@/lib/i18n';
import { postChannelMessage } from '@/lib/bot/qq-client';
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
  WorkspaceFailoverNotification,
} from '../notification-types';

const logger = createLogger('notification.qq');

interface QQConfig {
  appId: string;
  appSecret: string;
}

/**
 * QQ Official Bot notification channel.
 *
 * Auth + REST is shared with the chat-sdk Adapter shim (lib/bot/qq-adapter.ts)
 * via lib/bot/qq-client.ts — both paths exchange appId+appSecret for the
 * same QQ access_token and post to /channels/{id}/messages. Group-message
 * addressing (/v2/groups/{group_openid}/messages) is not wired in yet.
 *
 * targetChatId is the channel id (for guild channels) — QQ bot API
 * addresses messages per channel.
 */
export class QQNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'qq';
  private config: QQConfig;

  constructor(config: QQConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return !!this.config.appId && !!this.config.appSecret;
  }

  async send(
    targetChatId: string,
    payload: NotificationPayload,
  ): Promise<NotificationSendResult> {
    try {
      const content =
        payload.type === 'decision'
          ? await this.renderDecision(payload)
          : this.renderText(payload);

      const data = await postChannelMessage(this.config, targetChatId, content);
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
    payload:
      | CompletionNotification
      | L2TimeInputNotification
      | WorkspaceFailoverNotification,
  ): string {
    if (payload.type === 'l2_time_input') {
      return payload.promptMessage;
    }
    if (payload.type === 'workspace_failover') {
      const locale: Locale = payload.locale ?? defaultLocale;
      const migratedAt = payload.details?.migratedAt
        ? `\n\n_${t(locale, 'notify.workspaceFailover.migratedAt')}: ${payload.details.migratedAt}_`
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
