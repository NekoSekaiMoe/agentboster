/**
 * Minimal chat-sdk-compatible Adapter shim for Feishu.
 *
 * Feishu has no @chat-adapter package, so without this shim,
 * `bot.getAdapter('feishu')` returns undefined and every outbound path
 * (im-stream consumer, reply, voice fallback) NPEs. Inbound already
 * works (the webhook handler in callback/route.ts parses events and
 * calls routeAdapterMessage directly), and notifications already work
 * (notifications/feishu.ts uses the Feishu open API directly). This
 * shim fills the remaining gap: making feishu a first-class
 * postMessage/editMessage target so the agent can stream replies.
 *
 * What's implemented:
 *  - postMessage: post text/markdown to a chat (threadId = chat_id).
 *  - editMessage: PATCH the message content (Feishu PATCH /im/v1/messages/:id).
 *  - deleteMessage: DELETE the message.
 *  - startTyping: no-op (Feishu has no typing indicator API).
 *  - name: 'feishu' (matches AdapterName).
 *
 * What's intentionally NOT implemented:
 *  - fetchMessages, addReaction, openModal, postObject, etc. — these
 *    are optional on the Adapter interface and the IM streaming path
 *    doesn't use them. They can be added later when needed.
 *  - parseMessage / encodeThreadId / decodeThreadId — chat-sdk uses
 *    these for state persistence; feishu doesn't persist via chat-sdk
 *    state, so identity round-tripping isn't needed for outbound-only.
 *
 * Token management mirrors notifications/feishu.ts: tenant_access_token
 * cached with a 2h TTL.
 */

import { createLogger } from '@/lib/utils/logger';
import type { Adapter } from 'chat';

const logger = createLogger('bot.feishu-adapter');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
}

interface FeishuRawMessage {
  message_id?: string;
}

/**
 * Build the adapter. The chat-sdk Adapter interface requires many
 * methods for inbound/history/modals that feishu doesn't use (its
 * inbound runs through its own webhook, not chat-sdk). Rather than
 * implement a forest of dead stubs that fight chat-sdk's Message class
 * shape, we declare the methods the IM outbound path actually needs
 * and assert the result to Adapter at the factory call site
 * (lib/bot/adaptor.ts). Telegram's @chat-adapter package does the same
 * (TelegramAdapter is a plain object, not an `implements Adapter`).
 */
class FeishuBotAdapter {
  readonly name = 'feishu';
  readonly persistThreadHistory = false;

  private readonly cfg: FeishuAdapterConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg: FeishuAdapterConfig) {
    this.cfg = cfg;
  }
  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const resp = await fetch(
      `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_id: this.cfg.appId,
          app_secret: this.cfg.appSecret,
        }),
      },
    );
    const data = (await resp.json()) as {
      tenant_access_token?: string;
      expire?: number;
    };
    if (!data.tenant_access_token) {
      throw new Error('feishu: failed to get tenant_access_token');
    }
    this.accessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000 - 60_000;
    return this.accessToken;
  }

  /** Extract markdown text from an AdapterPostableMessage. */
  private toText(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      if (typeof m.markdown === 'string') return m.markdown;
      if (typeof m.text === 'string') return m.text;
      // PostableMarkdown / PostableRaw shapes
      if (typeof m.content === 'string') return m.content;
    }
    return String(message ?? '');
  }

  async postMessage(
    threadId: string,
    message: unknown,
  ): Promise<FeishuRawMessage> {
    const text = this.toText(message);
    const token = await this.getToken();
    const resp = await fetch(
      `${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: threadId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      },
    );
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: { message_id?: string };
    };
    if (data.code !== 0) {
      logger.error('feishu postMessage failed', {
        code: data.code,
        msg: data.msg,
      });
      throw new Error(`feishu postMessage: ${data.code} ${data.msg}`);
    }
    return { message_id: data.data?.message_id };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: unknown,
  ): Promise<FeishuRawMessage> {
    const text = this.toText(message);
    const token = await this.getToken();
    const resp = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const data = (await resp.json()) as {
      code: number;
      msg: string;
      data?: { message_id?: string };
    };
    if (data.code !== 0) {
      throw new Error(`feishu editMessage: ${data.code} ${data.msg}`);
    }
    void threadId;
    return { message_id: messageId };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(`${FEISHU_BASE}/im/v1/messages/${messageId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await resp.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      throw new Error(`feishu deleteMessage: ${data.code} ${data.msg}`);
    }
    void threadId;
  }

  async startTyping(): Promise<void> {
    // Feishu has no typing indicator API. No-op.
  }
}

/** Cast a FeishuBotAdapter to the chat-sdk Adapter shape. */
export function asFeishuAdapter(cfg: FeishuAdapterConfig): Adapter {
  return new FeishuBotAdapter(cfg) as unknown as Adapter;
}
