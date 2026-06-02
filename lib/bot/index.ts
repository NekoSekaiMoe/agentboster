import { routeAdapterMessage } from '@/lib/chat/index';
import { get, set } from '@/lib/core/kv';
import { getConfig } from '@/lib/core/kv/config';
import type { AdapterName, ChannelsConfig } from '@/types/config/channels';
import type { UserMessagePart } from '@/types/workflow';
import { type Attachment, Chat } from 'chat';
import { getBaseBot } from './core';

type IncomingThread = {
  adapter: { name: string };
  channelId?: string;
  id: string;
  subscribe: () => Promise<void>;
};

type IncomingMessage = {
  attachments?: Attachment[] | null;
  author?: {
    userId?: string | null;
    userName?: string | null;
  };
  text?: string | null;
  threadId: string;
};

async function attachmentToPart(
  attachment: Attachment,
): Promise<Extract<UserMessagePart, { type: 'file' }> | null> {
  if (attachment.type !== 'image' && attachment.type !== 'file') {
    return null;
  }

  const mediaType =
    attachment.mimeType ??
    (attachment.type === 'image' ? 'image/png' : 'application/octet-stream');
  const filename = attachment.name ?? 'Attachment';

  let url = attachment.url ?? '';
  if (attachment.fetchData || attachment.data) {
    const data = attachment.fetchData
      ? await attachment.fetchData()
      : attachment.data instanceof Blob
        ? Buffer.from(await attachment.data.arrayBuffer())
        : Buffer.from(attachment.data ?? '');

    if (data.byteLength > 0) {
      url = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
    }
  }

  if (!url) {
    return null;
  }

  return {
    type: 'file',
    filename,
    mediaType,
    url,
  };
}

async function buildMessageParts(
  message: IncomingMessage,
): Promise<UserMessagePart[]> {
  const parts: UserMessagePart[] = [];
  const text = (message.text ?? '').trim();

  if (text) {
    parts.push({
      type: 'text',
      text,
    });
  }

  if (message.attachments?.length) {
    const attachments = await Promise.all(
      message.attachments.map((attachment) => attachmentToPart(attachment)),
    );
    parts.push(
      ...attachments.filter(
        (part): part is Extract<UserMessagePart, { type: 'file' }> =>
          part !== null,
      ),
    );
  }

  return parts;
}

function isAllowedAdapterAuthor(
  channels: ChannelsConfig | undefined,
  adapter: AdapterName,
  message: IncomingMessage,
): boolean {
  const adapterConfig = channels?.[adapter];
  const allowedIds = adapterConfig?.allowed_author_ids ?? [];

  if (allowedIds.length === 0) {
    return true;
  }

  const authorUserId = message.author?.userId?.trim() ?? '';

  if (authorUserId.length > 0 && allowedIds.includes(authorUserId)) {
    return true;
  }

  return false;
}

/**
 * Create and return a Chat SDK bot instance.
 *
 * Platform messages are normalized to chatMain submit-message semantics,
 * so channel adapters reuse the same web routing/command/workflow stack.
 */
export async function getBot(): Promise<Chat> {
  const [bot, config] = await Promise.all([getBaseBot(), getConfig()]);

  async function handleIncomingMessage(
    thread: IncomingThread,
    message: IncomingMessage,
  ): Promise<void> {
    const adapter = thread.adapter.name as AdapterName;
    const parts = await buildMessageParts(message);
    const text = (message.text ?? '').trim();
    if (parts.length === 0) return;

    const userId = message.author?.userId?.trim() ?? '';

    if (!isAllowedAdapterAuthor(config?.channels, adapter, message)) {
      const isPairCommand = text.startsWith('/pair ');
      const isPaired =
        userId.length > 0 && (await get(`pair:bound:${adapter}:${userId}`));
      if (!isPairCommand || isPaired) {
        return;
      }
    }

    await routeAdapterMessage({
      adapter,
      origin: thread.channelId ?? thread.id,
      threadId: thread.id,
      userId: message.author?.userId ?? null,
      userName: message.author?.userName ?? null,
      text,
      parts,
    });
  }

  function dedupKey(thread: { id: string }, message: IncomingMessage): string {
    return `bot:dedup:${thread.id}:${message.author?.userId ?? ''}:${message.text ?? ''}`;
  }

  async function tryAcquireDedup(key: string): Promise<boolean> {
    const result = await set(key, '1', { ex: 30, nx: true });
    return result === 'OK';
  }

  bot.onNewMention(async (thread, message) => {
    const key = dedupKey(thread, message as IncomingMessage);
    if (!(await tryAcquireDedup(key))) return;
    await (thread as IncomingThread).subscribe();
    await handleIncomingMessage(
      thread as IncomingThread,
      message as IncomingMessage,
    );
  });

  bot.onSubscribedMessage(async (thread, message) => {
    const key = dedupKey(thread, message as IncomingMessage);
    if (!(await tryAcquireDedup(key))) return;
    await handleIncomingMessage(
      thread as IncomingThread,
      message as IncomingMessage,
    );
  });

  return bot;
}
