/**
 * Minimal chat-sdk-compatible Adapter shim for WeCom (企业微信) smart bot.
 *
 * Same pattern as feishu-adapter.ts / qq-adapter.ts: chat-sdk's full
 * Adapter interface requires inbound/history plumbing that WeCom doesn't
 * use (its inbound runs through the WeCom webhook in callback/route.ts),
 * so we implement only the outbound methods and cast at the factory
 * call site.
 *
 * Outbound strategy: we use the application-messaging API
 * (qyapi.weixin.qq.com/cgi-bin/message/send), NOT the smart-bot reply
 * API (aibot/response). Reasons:
 *  - aibot/response requires the per-event ResponseCode (1h window, 1 use)
 *    which is awkward to plumb through the agent streaming pipeline.
 *  - message/send uses access_token + agent_id + touser, can fire any
 *    time the agent wants to send a message. Quota is generous
 *    (account_size × 200/day per app, 30/min and 1000/hour per recipient).
 *  - For L2-decision push notifications (lib/extra/channels/notifications/wecom.ts)
 *    message/send is the only option anyway.
 *
 * threadId convention: threadId is the WeCom user id (From.UserId from
 * inbound). There's no thread/chat id beyond the 1:1 user — WeCom smart
 * bots are 1:1 only. Group chats would need a different API path
 * (chatid via appchat/send, not implemented here).
 *
 * Token management: access_token from corpid + secret, 2h TTL, cached
 * with 60s safety margin (mirrors feishu-adapter.ts).
 */

import type { Adapter } from 'chat';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('bot.wecom-adapter');

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

export interface WecomAdapterConfig {
  corpId: string;
  secret: string;
  /** Application agent_id (integer as string). */
  agentId: string;
}

interface WecomRawMessage {
  msgid?: string;
}

export class WecomBotAdapter {
  readonly name = 'wecom';
  readonly persistThreadHistory = false;

  private readonly cfg: WecomAdapterConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg: WecomAdapterConfig) {
    this.cfg = cfg;
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const url = `${WECOM_API}/gettoken?corpid=${encodeURIComponent(this.cfg.corpId)}&corpsecret=${encodeURIComponent(this.cfg.secret)}`;
    const resp = await fetch(url);
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
    this.accessToken = data.access_token;
    // expires_in defaults to 7200s; refresh 60s early.
    this.tokenExpiresAt =
      Date.now() + (data.expires_in ?? 7200) * 1000 - 60_000;
    return this.accessToken;
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

  async postMessage(
    threadId: string,
    message: unknown,
  ): Promise<WecomRawMessage> {
    const content = this.toText(message);
    const token = await this.getToken();
    const resp = await fetch(
      `${WECOM_API}/message/send?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: threadId,
          msgtype: 'text',
          agentid: Number.parseInt(this.cfg.agentId, 10),
          text: { content },
        }),
      },
    );
    const data = (await resp.json()) as {
      errcode?: number;
      errmsg?: string;
      msgid?: string;
    };
    if (data.errcode !== 0) {
      logger.error('wecom postMessage failed', {
        errcode: data.errcode,
        errmsg: data.errmsg,
      });
      throw new Error(`wecom postMessage: ${data.errcode} ${data.errmsg}`);
    }
    return { msgid: data.msgid };
  }

  /**
   * WeCom's application-messaging API has no editMessage. To approximate
   * streaming, we'd need to delete + repost (which floods the chat) or
   * use a template_card with response_code (one-shot 72h). For now we
   * re-post the new content as a fresh message — the im-stream consumer
   * will call this for each chunk when capabilities.edit is true, which
   * WeCom explicitly sets to false, so this method should not be
   * reached in practice. Implemented defensively so the shim type-checks.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: unknown,
  ): Promise<WecomRawMessage> {
    void messageId;
    return this.postMessage(threadId, message);
  }

  /**
   * WeCom has 撤回应用消息 (POST /message/recall with msgid), but only
   * for application messages, not smart-bot replies. Implemented here
   * so the shim typechecks; capabilities.delete is false so this is
   * not called by im-stream.
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const token = await this.getToken();
    const resp = await fetch(
      `${WECOM_API}/message/recall?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgid: messageId }),
      },
    );
    const data = (await resp.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      throw new Error(`wecom recall: ${data.errcode} ${data.errmsg ?? ''}`);
    }
    void threadId;
  }

  /** WeCom has no typing indicator API. */
  async startTyping(): Promise<void> {}
}

/** Cast a WecomBotAdapter to the chat-sdk Adapter shape. */
export function asWecomAdapter(cfg: WecomAdapterConfig): Adapter {
  return new WecomBotAdapter(cfg) as unknown as Adapter;
}
