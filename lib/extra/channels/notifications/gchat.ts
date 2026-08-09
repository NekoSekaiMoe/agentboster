import { defaultLocale, type Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config';
import type { NotificationChannel } from '../notification-channel';
import type {
  NotificationPayload,
  NotificationSendResult,
} from '../notification-types';

const logger = createLogger('notification.gchat');

interface GChatConfig {
  projectId: string;
  credentialsJson: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Google Chat notification channel.
 *
 * Uses a GCP service account to mint a self-signed JWT, exchanges it
 * for a Google OAuth access token (scope
 * `https://www.googleapis.com/auth/chat.bot`), then posts a simple
 * text message to a space. targetChatId is the Google Chat space name
 * (e.g. `spaces/AAAAA123`).
 *
 * Interactive cards with buttons (for L2 decisions) are technically
 * supported by the Chat API but require the bot to be installed into
 * the space and to handle CARD_CLICKED events; for now this channel
 * renders decision prompts as text, and the user replies via natural
 * language / re-runs — consistent with the fallback shape other
 * channels use when their rich UI is unavailable.
 */
export class GChatNotificationChannel implements NotificationChannel {
  readonly type: AdapterName = 'gchat';
  private config: GChatConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: GChatConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    if (!this.config.projectId || !this.config.credentialsJson) return false;
    try {
      JSON.parse(this.config.credentialsJson);
      return true;
    } catch {
      return false;
    }
  }

  private parseKey(): ServiceAccountKey | null {
    try {
      const key = JSON.parse(this.config.credentialsJson);
      if (!key.client_email || !key.private_key) return null;
      return key;
    } catch {
      return null;
    }
  }

  private base64url(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64url');
  }

  /**
   * Mint a self-signed JWT from the service account key and exchange
   * it for a Google OAuth access token. Cached until expiry.
   */
  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const key = this.parseKey();
    if (!key) {
      throw new Error('invalid service account credentials JSON');
    }

    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/chat.bot',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const header = { alg: 'RS256', typ: 'JWT' };
    const unsigned = `${this.base64url(JSON.stringify(header))}.${this.base64url(JSON.stringify(claim))}`;

    const { createSign } = await import('node:crypto');
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(Buffer.from(key.private_key, 'utf-8'));
    const assertion = `${unsigned}.${this.base64url(signature)}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`google oauth error: ${resp.status} ${text}`);
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
        throw new Error('could not obtain google oauth access token');
      }

      const space = targetChatId.startsWith('spaces/')
        ? targetChatId
        : `spaces/${targetChatId}`;
      const text = this.renderText(payload);

      // L2 decisions render as a Card v2 with four buttons. The chat-sdk
      // gchat adapter (handleCardClick in @chat-adapter/gchat) extracts
      // `commonEvent.parameters.actionId` from CARD_CLICKED events and
      // dispatches via chat.processAction; the bot.onAction catch-all
      // in lib/bot/index.ts matches the `l2:` regex and runs
      // processL2Decision. Each button's onClick action.parameters must
      // carry an `actionId` parameter for the chat-sdk extraction to
      // work (see @chat-adapter/gchat index.js:1299).
      const body =
        payload.type === 'decision'
          ? this.buildDecisionBody(payload, text)
          : { text };

      const resp = await fetch(
        `https://chat.googleapis.com/v1/${space}/messages`,
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
        throw new Error(`gchat api error: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as { name?: string };
      return {
        success: true,
        channel: this.type,
        messageId: data.name ?? '',
      };
    } catch (error) {
      logger.error('gchat send failed', {
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
        `*${payload.title}*`,
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
        ? `\n\n_Migrated at: ${payload.details.migratedAt}_`
        : '';
      return `⚠️ *${payload.title}*\n\n${payload.summary}${migratedAt}`;
    }

    const emoji =
      payload.status === 'completed'
        ? '✅'
        : payload.status === 'failed'
          ? '❌'
          : '⏹️';
    return `${emoji} *${payload.title}*\n\n${payload.summary}`;
  }

  /**
   * Build a Google Chat Card v2 body carrying the decision prompt as
   * TextParagraph + four Buttons. Each button's onClick action passes
   * an `actionId` parameter so the chat-sdk gchat adapter can route
   * CARD_CLICKED into processAction → bot.onAction catch-all.
   */
  private buildDecisionBody(
    payload: Extract<NotificationPayload, { type: 'decision' }>,
    text: string,
  ): Record<string, unknown> {
    const locale: Locale = payload.locale ?? defaultLocale;
    const { taskId, decisionId } = payload;
    const action = (a: string) => `l2:${a}:${taskId}:${decisionId}`;

    const button = (label: string, a: string) => ({
      text: label,
      onClick: {
        action: {
          function: 'l2Decision',
          parameters: [{ key: 'actionId', value: action(a) }],
        },
      },
    });

    return {
      cardsV2: [
        {
          cardId: `l2-${decisionId}`,
          card: {
            header: { title: payload.title },
            sections: [
              {
                widgets: [
                  { textParagraph: { text } },
                  {
                    buttonList: {
                      buttons: [
                        button(
                          `✅ ${t(locale, 'notify.l2.passOnce')}`,
                          'pass_once',
                        ),
                        button(
                          `⏱ ${t(locale, 'notify.l2.passUntil')}`,
                          'pass_until',
                        ),
                        button(
                          `❌ ${t(locale, 'notify.l2.rejectOnce')}`,
                          'reject_once',
                        ),
                        button(
                          `🔕 ${t(locale, 'notify.l2.rejectUntil')}`,
                          'reject_until',
                        ),
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
  }

  parseDecisionReply(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const params = (
      body as {
        common?: {
          invocationEvent?: {
            commonParameters?: {
              parameters?: Array<{ key: string; value: string }>;
            };
          };
        };
      }
    )?.common?.invocationEvent?.commonParameters?.parameters;
    if (!Array.isArray(params)) return null;
    const actionId = params.find(
      (p) => p.key === 'actionId' && typeof p.value === 'string',
    )?.value;
    if (!actionId) return null;
    return /^l2:(pass_once|pass_until|reject_once|reject_until):/.test(actionId)
      ? actionId
      : null;
  }
}
