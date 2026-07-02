export type ChannelType =
  | 'feishu'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'gchat'
  | 'teams'
  | 'qq'
  | 'wecom';

export interface IncomingMessage {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  raw: unknown;
}

export interface OutgoingMessage {
  text: string;
  attachments?: OutgoingAttachment[];
  replyToMessageId?: string;
}

export interface OutgoingAttachment {
  type: 'image' | 'file' | 'card';
  url?: string;
  content?: string;
  title?: string;
}

export interface IChannelAdapter {
  readonly type: ChannelType;
  init(config: Record<string, unknown>): Promise<void>;
  sendMessage(chatId: string, msg: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  getChannelInfo(): { name: string; connected: boolean };
}
