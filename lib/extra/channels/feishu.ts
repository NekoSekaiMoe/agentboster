import { ofetch } from 'ofetch';
import type {
  ChannelType,
  IChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from './types';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

interface FeishuTokenResponse {
  tenant_access_token: string;
  expire: number;
}

interface FeishuMessage {
  message_id: string;
  chat_id: string;
  msg_type: string;
  sender: {
    sender_id: { union_id?: string; user_id?: string; open_id?: string };
    sender_type: string;
  };
  message: {
    content: string;
  };
}

export class FeishuAdapter implements IChannelAdapter {
  readonly type: ChannelType = 'feishu';
  private config: FeishuConfig | null = null;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private messageHandlers: Array<(msg: IncomingMessage) => Promise<void>> = [];
  private connected = false;

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = config as unknown as FeishuConfig;
    await this.refreshToken();
    this.connected = true;
  }

  async sendMessage(chatId: string, msg: OutgoingMessage): Promise<void> {
    await this.ensureToken();

    await ofetch('https://open.feishu.cn/open-apis/im/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: msg.text }),
      },
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  getChannelInfo(): { name: string; connected: boolean } {
    return { name: 'Feishu/Lark', connected: this.connected };
  }

  async handleWebhook(payload: {
    header: { event_type: string };
    event: { message?: FeishuMessage; sender?: unknown };
  }): Promise<void> {
    const message = payload.event?.message;
    if (!message) return;

    const incoming: IncomingMessage = {
      channelType: this.type,
      chatId: message.chat_id,
      userId: message.sender?.sender_id?.open_id ?? '',
      text: this.extractText(message),
      raw: payload,
    };

    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }

  private extractText(message: FeishuMessage): string {
    try {
      const content = JSON.parse(message.message?.content ?? '{}') as {
        text?: string;
      };
      return content.text ?? '';
    } catch {
      return '';
    }
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return;
    await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    if (!this.config) throw new Error('Feishu adapter not initialized');

    const result = await ofetch<FeishuTokenResponse>(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        },
      },
    );

    this.accessToken = result.tenant_access_token;
    this.tokenExpiry = Date.now() + (result.expire - 300) * 1000;
  }
}
