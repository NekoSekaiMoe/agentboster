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
      // L2 decision prompts ship as an Adaptive Card with Action.Submit
      // buttons so the user can tap a verdict instead of typing. The
      // chat-sdk teams adapter (handleAdaptiveCardAction in
      // @chat-adapter/teams) extracts `activity.value.action.data.actionId`
      // and dispatches via chat.processAction, where the bot.onAction
      // catch-all in lib/bot/index.ts matches the `l2:` regex and runs
      // processL2Decision. Action.Submit data must carry `actionId` and
      // may carry an arbitrary `value` (we encode the same payload for
      // traceability).
      const body =
        payload.type === 'decision'
          ? this.buildDecisionBody(payload, text)
          : {
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

    if (payload.type === 'workspace_failover') {
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

  /**
   * Build a Bot Framework activity carrying an Adaptive Card with four
   * Action.Submit buttons (pass_once / pass_until / reject_once /
   * reject_until). Each button's `data.actionId` is the `l2:...` payload
   * the bot.onAction catch-all matches.
   */
  private buildDecisionBody(
    payload: Extract<NotificationPayload, { type: 'decision' }>,
    text: string,
  ): Record<string, unknown> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const { taskId, decisionId } = payload;
    const action = (a: string) => `l2:${a}:${taskId}:${decisionId}`;

    const button = (
      title: string,
      a: string,
      style: 'positive' | 'destructive' | 'default',
    ) => ({
      type: 'Action.Submit',
      title,
      style,
      data: { actionId: action(a) },
    });

    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [{ type: 'TextBlock', text, wrap: true }],
            actions: [
              button(
                `✅ ${t(locale, 'notify.l2.passOnce')}`,
                'pass_once',
                'positive',
              ),
              button(
                `⏱ ${t(locale, 'notify.l2.passUntil')}`,
                'pass_until',
                'default',
              ),
              button(
                `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
                'reject_once',
                'destructive',
              ),
              button(
                `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
                'reject_until',
                'default',
              ),
            ],
          },
        },
      ],
    };
  }

  /**
   * Parse an inbound Teams invoke activity for an L2 button click.
   * Teams dispatches Action.Submit through Bot Framework's invoke route,
   * which the chat-sdk teams adapter forwards to processAction; this
   * parser is only used when the notification manager receives the raw
   * webhook body directly (e.g. a fallback path that bypasses chat-sdk).
   */
  parseDecisionReply(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const data = (
      body as { value?: { action?: { data?: { actionId?: string } } } }
    )?.value?.action?.data;
    if (!data || typeof data.actionId !== 'string') return null;
    return /^l2:(pass_once|pass_until|reject_once|reject_until):/.test(
      data.actionId,
    )
      ? data.actionId
      : null;
  }
}
