import type {
  ChannelType,
  IChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from './types';

export class ChannelManager {
  private adapters = new Map<ChannelType, IChannelAdapter>();
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];

  registerAdapter(adapter: IChannelAdapter): void {
    this.adapters.set(adapter.type, adapter);
    adapter.onMessage(async (msg) => {
      for (const handler of this.messageHandlers) {
        await handler(msg);
      }
    });
  }

  async initAdapter(
    type: ChannelType,
    config: Record<string, unknown>,
  ): Promise<void> {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${type}`);
    }
    await adapter.init(config);
  }

  async sendMessage(
    channelType: ChannelType,
    chatId: string,
    msg: OutgoingMessage,
  ): Promise<void> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }
    await adapter.sendMessage(chatId, msg);
  }

  async broadcastMessage(
    chatIds: Array<{ channelType: ChannelType; chatId: string }>,
    msg: OutgoingMessage,
  ): Promise<void> {
    const promises = chatIds.map(({ channelType, chatId }) =>
      this.sendMessage(channelType, chatId, msg),
    );
    await Promise.allSettled(promises);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  getAdapter(type: ChannelType): IChannelAdapter | null {
    return this.adapters.get(type) ?? null;
  }

  getChannelInfo(): Array<{
    type: ChannelType;
    name: string;
    connected: boolean;
  }> {
    return Array.from(this.adapters.values()).map((adapter) => {
      const info = adapter.getChannelInfo();
      return {
        type: adapter.type,
        name: info.name,
        connected: info.connected,
      };
    });
  }

  getRegisteredTypes(): ChannelType[] {
    return Array.from(this.adapters.keys());
  }
}
