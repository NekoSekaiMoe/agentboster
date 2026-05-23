import { ofetch } from 'ofetch';
import type {
  ChannelType,
  IChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from './types';

interface SlackConfig {
  botToken: string;
  signingSecret?: string;
  appId?: string;
}

interface SlackEventPayload {
  type: string;
  event?: {
    type: string;
    channel: string;
    user: string;
    text?: string;
    thread_ts?: string;
  };
  challenge?: string;
}

export class SlackAdapter implements IChannelAdapter {
  readonly type: ChannelType = 'slack';
  private config: SlackConfig | null = null;
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private connected = false;

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = config as unknown as SlackConfig;
    this.connected = true;
  }

  async sendMessage(chatId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.config) throw new Error('Slack adapter not initialized');

    await ofetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        channel: chatId,
        text: msg.text,
        thread_ts: msg.replyToMessageId,
      },
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  getChannelInfo(): { name: string; connected: boolean } {
    return { name: 'Slack', connected: this.connected };
  }

  async handleEvent(payload: SlackEventPayload): Promise<string | undefined> {
    if (payload.type === 'url_verification') {
      return payload.challenge;
    }

    const event = payload.event;
    if (!event || event.type !== 'message') return undefined;

    const incoming: IncomingMessage = {
      channelType: this.type,
      chatId: event.channel,
      userId: event.user,
      text: event.text ?? '',
      raw: payload,
    };

    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }

    return undefined;
  }
}
