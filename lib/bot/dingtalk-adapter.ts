/**
 * Minimal chat-sdk-compatible Adapter shim for DingTalk (钉钉) application bot.
 *
 * Same shim pattern as feishu-adapter / qq-adapter / wecom-adapter: only
 * outbound methods, cast to Adapter at registration. Inbound runs through
 * app/api/bot/[authSecret]/[adapter]/callback/route.ts handleDingtalkWebhook.
 *
 * Outbound: uses the OpenAPI robot send endpoints rather than the
 * per-message sessionWebhook (which is temporary and single-use per
 * inbound event). The OpenAPI endpoints accept conversationId + robotCode
 * + access_token and can fire any time.
 *   - Single chat: POST /v1.0/robot/oToMessages/batchSend
 *   - Group chat:  POST /v1.0/robot/groupMessages/send
 *
 * The adapter uses sampleText / sampleMarkdown message templates (the
 * simplest built-in templates that take a content string), matching how
 * DingTalk's own examples work.
 *
 * threadId convention: threadId is the conversationId from inbound
 * (payload.conversationId). Single-chat and group-chat share the same
 * conversationId space in DingTalk, and we use conversationType (1/2)
 * carried via messageId metadata... but actually since OpenAPI has
 * separate endpoints for single vs group, we need to know which.
 * Simplification: store the type on the threadId itself using a
 * `single:` or `group:` prefix, set by the webhook handler; this
 * adapter strips the prefix and dispatches to the right endpoint.
 *
 * Token: app access_token from /v1.0/oauth2/accessToken (appKey + appSecret),
 * ~7200s TTL, cached with 60s safety margin.
 */

import type { Adapter } from 'chat';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('bot.dingtalk-adapter');

const DINGTALK_API = 'https://api.dingtalk.com/v1.0';

export interface DingtalkAdapterConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
}

interface DingtalkRawMessage {
  processQueryKey?: string;
  messageId?: string;
}

const SINGLE_PREFIX = 'single:';
const GROUP_PREFIX = 'group:';

class DingtalkBotAdapter {
  readonly name = 'dingtalk';
  readonly persistThreadHistory = false;

  private readonly cfg: DingtalkAdapterConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg: DingtalkAdapterConfig) {
    this.cfg = cfg;
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const resp = await fetch(`${DINGTALK_API}/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appKey: this.cfg.appKey,
        appSecret: this.cfg.appSecret,
      }),
    });
    const data = (await resp.json()) as {
      accessToken?: string;
      expireIn?: number;
    };
    if (!data.accessToken) {
      throw new Error('dingtalk: failed to get accessToken');
    }
    this.accessToken = data.accessToken;
    this.tokenExpiresAt = Date.now() + (data.expireIn ?? 7200) * 1000 - 60_000;
    return this.accessToken;
  }

  private parseThreadId(threadId: string): {
    conversationId: string;
    isGroup: boolean;
  } {
    if (threadId.startsWith(SINGLE_PREFIX)) {
      return {
        conversationId: threadId.slice(SINGLE_PREFIX.length),
        isGroup: false,
      };
    }
    if (threadId.startsWith(GROUP_PREFIX)) {
      return {
        conversationId: threadId.slice(GROUP_PREFIX.length),
        isGroup: true,
      };
    }
    // No prefix: default to single-chat (the common case for 1:1 bot convos).
    return { conversationId: threadId, isGroup: false };
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
  ): Promise<DingtalkRawMessage> {
    const content = this.toText(message);
    const token = await this.getToken();
    const { conversationId, isGroup } = this.parseThreadId(threadId);

    // Use sampleMarkdown for richer rendering when the content looks like
    // markdown; fall back to sampleText for plain text. DingTalk's message
    // templates take msgParam as a JSON-encoded string.
    const isMarkdown = /[*_`#\-[\]]/.test(content);
    const msgKey = isMarkdown ? 'sampleMarkdown' : 'sampleText';
    const msgParam = isMarkdown
      ? JSON.stringify({ title: 'Agent', text: content })
      : JSON.stringify({ content });

    const endpoint = isGroup
      ? `${DINGTALK_API}/robot/groupMessages/send`
      : `${DINGTALK_API}/robot/oToMessages/batchSend`;

    const body = isGroup
      ? {
          msgParam,
          msgKey,
          openConversationId: conversationId,
          robotCode: this.cfg.robotCode,
        }
      : {
          msgParam,
          msgKey,
          robotCode: this.cfg.robotCode,
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
    const data = (await resp.json()) as {
      code?: number;
      message?: string;
      processQueryKey?: string;
    };
    // DingTalk OpenAPI uses code != 0 for errors (response body code, not HTTP).
    if (data.code !== undefined && data.code !== 0) {
      logger.error('dingtalk postMessage failed', {
        code: data.code,
        message: data.message,
      });
      throw new Error(
        `dingtalk postMessage: ${data.code} ${data.message ?? ''}`,
      );
    }
    return { processQueryKey: data.processQueryKey };
  }

  /**
   * DingTalk has no editMessage. The OpenAI-card flow supports PUT updates
   * to a card instance, but that's a different message type entirely and
   * requires a cardInstanceId we don't track. capabilities.edit is false
   * so this won't be called by im-stream; implemented defensively.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: unknown,
  ): Promise<DingtalkRawMessage> {
    void messageId;
    return this.postMessage(threadId, message);
  }

  /**
   * DingTalk has no general message-delete API for bot-sent messages.
   * capabilities.delete is false; this is a defensive stub.
   */
  async deleteMessage(): Promise<void> {}

  /** DingTalk has no typing indicator API. */
  async startTyping(): Promise<void> {}
}

/** Cast a DingtalkBotAdapter to the chat-sdk Adapter shape. */
export function asDingtalkAdapter(cfg: DingtalkAdapterConfig): Adapter {
  return new DingtalkBotAdapter(cfg) as unknown as Adapter;
}

/**
 * Exported so the webhook handler can build a threadId with the right
 * prefix for the adapter to pick up. conversationType 1 = single, 2 = group.
 */
export function buildDingtalkThreadId(
  conversationId: string,
  conversationType: string,
): string {
  return conversationType === '2'
    ? `${GROUP_PREFIX}${conversationId}`
    : `${SINGLE_PREFIX}${conversationId}`;
}
