import { ofetch } from 'ofetch';
import type {
  ChannelType,
  IChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from './types';

interface TelegramConfig {
  botToken: string;
  webhookSecret?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
  };
}

export class TelegramAdapter implements IChannelAdapter {
  readonly type: ChannelType = 'telegram';
  private config: TelegramConfig | null = null;
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private connected = false;

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = config as unknown as TelegramConfig;
    this.connected = true;
  }

  async sendMessage(chatId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.config) throw new Error('Telegram adapter not initialized');

    await ofetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          chat_id: chatId,
          text: msg.text,
          reply_to_message_id: msg.replyToMessageId
            ? Number(msg.replyToMessageId)
            : undefined,
        },
      },
    );
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  getChannelInfo(): { name: string; connected: boolean } {
    return { name: 'Telegram', connected: this.connected };
  }

  async handleWebhook(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;

    const incoming: IncomingMessage = {
      channelType: this.type,
      chatId: String(message.chat.id),
      userId: message.from ? String(message.from.id) : '',
      text: message.text,
      raw: update,
    };

    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }
}
