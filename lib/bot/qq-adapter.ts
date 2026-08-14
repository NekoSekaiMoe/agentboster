/**
 * Minimal chat-sdk-compatible Adapter shim for QQ Official Bot.
 *
 * Same gap as feishu-adapter.ts: QQ has no @chat-adapter package, so
 * without this shim `bot.getAdapter('qq')` is undefined and every
 * outbound IM path NPEs. Inbound already works (callback/route.ts
 * handles op=0 message events), notifications already work
 * (notifications/qq.ts), this fills the postMessage/editMessage gap.
 *
 * All token exchange + REST calls live in lib/bot/qq-client.ts and are
 * shared with notifications/qq.ts; this shim only translates the
 * chat-sdk AdapterPostableMessage shape (string | {markdown|text|content})
 * into the plain content string the QQ API expects, then delegates.
 *
 * threadId convention: the QQ inbound webhook sets threadId to the
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

import {
  deleteChannelMessage,
  patchChannelMessage,
  postChannelMessage,
  type QQClientConfig,
} from '@/lib/bot/qq-client';
import type { Adapter } from 'chat';

export type { QQClientConfig as QQAdapterConfig } from '@/lib/bot/qq-client';

interface QQRawMessage {
  id?: string;
}

/**
 * Build the adapter. Same pattern as feishu-adapter.ts: chat-sdk's
 * full Adapter interface requires inbound/history plumbing that QQ
 * doesn't use (it has its own webhook), so we implement just the
 * outbound methods and cast at the factory call site.
 */
class QQBotAdapter {
  readonly name = 'qq';
  readonly persistThreadHistory = false;

  private readonly cfg: QQClientConfig;

  constructor(cfg: QQClientConfig) {
    this.cfg = cfg;
  }

  /** Extract markdown/text content from an AdapterPostableMessage. */
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
    return postChannelMessage(this.cfg, threadId, this.toText(message));
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: unknown,
  ): Promise<QQRawMessage> {
    return patchChannelMessage(
      this.cfg,
      threadId,
      messageId,
      this.toText(message),
    );
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    await deleteChannelMessage(this.cfg, threadId, messageId);
  }

  async startTyping(): Promise<void> {
    // QQ has no typing indicator. No-op.
  }
}

/** Cast a QQBotAdapter to the chat-sdk Adapter shape. */
export function asQQAdapter(cfg: QQClientConfig): Adapter {
  return new QQBotAdapter(cfg) as unknown as Adapter;
}
