import { ofetch } from 'ofetch';
import type {
  ChannelType,
  IChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from './types';

interface DiscordConfig {
  botToken: string;
  applicationId?: string;
}

interface DiscordInteraction {
  id: string;
  type: number;
  data?: {
    name: string;
    options?: Array<{ name: string; value: string }>;
  };
  channel_id: string;
  user?: { id: string; username: string };
  member?: { user: { id: string; username: string } };
  message?: {
    id: string;
    content: string;
    channel_id: string;
    author: { id: string; username: string };
  };
}

export class DiscordAdapter implements IChannelAdapter {
  readonly type: ChannelType = 'discord';
  private config: DiscordConfig | null = null;
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private connected = false;

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = config as unknown as DiscordConfig;
    this.connected = true;
  }

  async sendMessage(chatId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.config) throw new Error('Discord adapter not initialized');

    await ofetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        content: msg.text,
        message_reference: msg.replyToMessageId
          ? { message_id: msg.replyToMessageId }
          : undefined,
      },
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  getChannelInfo(): { name: string; connected: boolean } {
    return { name: 'Discord', connected: this.connected };
  }

  async handleInteraction(interaction: DiscordInteraction): Promise<unknown> {
    if (interaction.type === 2 && interaction.data) {
      const userId = interaction.user?.id ?? interaction.member?.user?.id ?? '';
      const text = interaction.data.options?.[0]?.value ?? '';

      const incoming: IncomingMessage = {
        channelType: this.type,
        chatId: interaction.channel_id,
        userId,
        text,
        raw: interaction,
      };

      for (const handler of this.messageHandlers) {
        await handler(incoming);
      }

      return { type: 4, data: { content: 'Processing...' } };
    }

    if (interaction.type === 3) {
      return { type: 1 };
    }

    return { type: 4, data: { content: 'Unknown interaction type' } };
  }
}
