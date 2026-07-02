/**
 * Minimal chat-sdk-compatible Adapter shim for QQ Official Bot.
 *
 * Same gap as feishu-adapter.ts: QQ has no @chat-adapter package, so
 * without this shim `bot.getAdapter('qq')` is undefined and every
 * outbound IM path NPEs. Inbound already works (callback/route.ts
 * handles op=0 message events), notifications already work
 * (notifications/qq.ts), this fills the postMessage/editMessage gap.
 *
 * Auth: exchange appId + appSecret for an app access token at
 * https://bots.qq.com/app/getAppAccessToken, then call the v2 Open API.
 *
 * threadId convention: the QQ inbound webhook now sets threadId to the
 * send target (channel_id for guild channels, group_openid for group
 * messages). This adapter assumes guild-channel addressing
 * (/channels/{threadId}/messages), which is the QQ Official Bot
 * mainstream scenario. Group-message addressing
 * (/v2/groups/{group_openid}/messages) is a separate send path that
 * will be added when a deployment actually uses QQ groups.
 *
 * What's implemented: postMessage, editMessage, deleteMessage,
 * startTyping (no-op — QQ has no typing API), and chat-sdk plumbing
 * stubs. fetchMessages / addReaction / openModal are intentionally
 * no-ops — see feishu-adapter.ts for the same rationale.
 */

import { createLogger } from '@/lib/utils/logger';
import type { Adapter } from 'chat';

const logger = createLogger('bot.qq-adapter');

const QQ_API = 'https://api.sgroup.qq.com';

export interface QQAdapterConfig {
  appId: string;
  appSecret: string;
}

interface QQRawMessage {
  id?: string;
}

/**
 * Build the adapter. Same pattern as feishu-adapter.ts: chat-sdk's
 * full Adapter interface requires inbound/history plumbing that QQ
 * doesn't use (it has its own webhook), so we implement just the
 * outbound methods and cast at the factory call site.
 */
export class QQBotAdapter {
  readonly name = 'qq';
  readonly persistThreadHistory = false;

  private readonly cfg: QQAdapterConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg: QQAdapterConfig) {
    this.cfg = cfg;
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: this.cfg.appId,
        clientSecret: this.cfg.appSecret,
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

  private toText(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      if (typeof m.markdown === 'string') return m.markdown;
      if (typeof m.text === 'string') return m.text;
      if (typeof m.content === 'string') return m.content;
    }
    return String(message ?? '');
  }

  async postMessage(threadId: string, message: unknown): Promise<QQRawMessage> {
    const content = this.toText(message);
    const token = await this.getToken();
    const resp = await fetch(`${QQ_API}/channels/${threadId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.error('qq postMessage failed', {
        status: resp.status,
        body: text,
      });
      throw new Error(`qq postMessage: ${resp.status} ${text}`);
    }
    const data = (await resp.json()) as { id?: string };
    return { id: data.id };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: unknown,
  ): Promise<QQRawMessage> {
    const content = this.toText(message);
    const token = await this.getToken();
    const resp = await fetch(
      `${QQ_API}/channels/${threadId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `QQBot ${token}`,
        },
        body: JSON.stringify({ content }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`qq editMessage: ${resp.status} ${text}`);
    }
    const data = (await resp.json()) as { id?: string };
    return { id: messageId ?? data.id };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `${QQ_API}/channels/${threadId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: { authorization: `QQBot ${token}` },
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`qq deleteMessage: ${resp.status} ${text}`);
    }
  }

  async startTyping(): Promise<void> {
    // QQ has no typing indicator. No-op.
  }
}

/** Cast a QQBotAdapter to the chat-sdk Adapter shape. */
export function asQQAdapter(cfg: QQAdapterConfig): Adapter {
  return new QQBotAdapter(cfg) as unknown as Adapter;
}
