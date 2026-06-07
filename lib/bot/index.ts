import { routeAdapterMessage } from '@/lib/chat/index';
import {
  createSession,
  listSessionsByExternalThreadIds,
  updateSession,
  upsertPersistedMessage,
} from '@/lib/core/db/chat';
import {
  serializeAssistantMessage,
  serializeUserMessage,
} from '@/lib/chat/message-utils';
import { get, set } from '@/lib/core/kv';
import { getConfig } from '@/lib/core/kv/config';
import type { AdapterName, ChannelsConfig } from '@/types/config/channels';
import {
  buildExternalThreadId,
  type ChatSource,
  type UserMessagePart,
} from '@/types/workflow';
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

const ACCESS_DENIED_TEXT = '拒绝访问：你的账号未被允许使用此 bot。';
const ACCESS_DENIED_TITLE = '拒绝访问';
const ACCESS_DENIED_USER_MESSAGE_ID = 'access-denied:user';
const ACCESS_DENIED_ASSISTANT_MESSAGE_ID = 'access-denied:assistant';

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

function buildIncomingSource(
  adapter: AdapterName,
  thread: IncomingThread,
  message: IncomingMessage,
): Extract<ChatSource, { type: 'im' }> {
  return {
    type: 'im',
    adapter,
    origin: thread.channelId ?? thread.id,
    threadId: thread.id,
    userId: message.author?.userId ?? null,
    userName: message.author?.userName ?? null,
  };
}

function getIncomingExternalThreadIds(
  source: Extract<ChatSource, { type: 'im' }>,
): string[] {
  return [buildExternalThreadId(source), source.threadId].filter(
    (value, index, values): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      values.indexOf(value) === index,
  );
}

async function persistAccessDeniedSession(input: {
  adapter: AdapterName;
  source: Extract<ChatSource, { type: 'im' }>;
  text: string;
}): Promise<void> {
  const externalThreadIds = getIncomingExternalThreadIds(input.source);
  const externalThreadId = externalThreadIds[0] ?? null;
  const [existing] =
    externalThreadIds.length > 0
      ? await listSessionsByExternalThreadIds(externalThreadIds)
      : [];
  const deniedAt = new Date();
  const metadata = {
    ...(existing?.metadata ?? {}),
    source: input.source,
    accessDenied: {
      reason: 'adapter_author_not_allowed',
      adapter: input.adapter,
      userId: input.source.userId,
      deniedAt: deniedAt.toISOString(),
    },
  };
  const session =
    existing ??
    (await createSession({
      title: ACCESS_DENIED_TITLE,
      channel: input.adapter,
      externalThreadId,
      userId: input.source.userId ?? null,
      metadata,
    }));

  if (existing) {
    await updateSession(existing.id, {
      title: existing.title ?? ACCESS_DENIED_TITLE,
      channel: input.adapter,
      externalThreadId,
      userId: input.source.userId ?? null,
      metadata,
    });
  }

  const deniedText = ACCESS_DENIED_TEXT;
  const userText = input.text || '/start';
  await Promise.all([
    upsertPersistedMessage(
      serializeUserMessage({
        sessionId: session.id,
        uiMessageId: ACCESS_DENIED_USER_MESSAGE_ID,
        text: userText,
        parts: [{ type: 'text', text: userText }],
        source: input.source,
        createdAt: deniedAt,
      }),
    ),
    upsertPersistedMessage({
      ...serializeAssistantMessage({
        sessionId: session.id,
        text: deniedText,
        createdAt: new Date(deniedAt.getTime() + 1),
      }),
      uiMessageId: ACCESS_DENIED_ASSISTANT_MESSAGE_ID,
    }),
  ]);
}

async function sendAccessDeniedReply(input: {
  bot: Chat;
  adapter: AdapterName;
  threadId: string;
}): Promise<void> {
  const adapter = input.bot.getAdapter(input.adapter);
  await adapter.postMessage(input.threadId, {
    markdown: ACCESS_DENIED_TEXT,
  });
}

async function clearAccessDeniedSession(
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  const externalThreadIds = getIncomingExternalThreadIds(source);
  if (externalThreadIds.length === 0) {
    return;
  }

  const [session] = await listSessionsByExternalThreadIds(externalThreadIds);
  const metadata = session?.metadata;
  if (!session || !metadata || !('accessDenied' in metadata)) {
    return;
  }

  const nextMetadata = { ...metadata };
  delete nextMetadata.accessDenied;
  await updateSession(session.id, {
    metadata: nextMetadata,
    title: session.title === ACCESS_DENIED_TITLE ? null : session.title,
  });
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
    const source = buildIncomingSource(adapter, thread, message);

    if (!isAllowedAdapterAuthor(config?.channels, adapter, message)) {
      const isPairCommand = text.startsWith('/pair ');
      const isPaired =
        userId.length > 0 && (await get(`pair:bound:${adapter}:${userId}`));
      if (isPairCommand && !isPaired) {
        // Unpaired users need /pair to complete authorization.
      } else {
        await persistAccessDeniedSession({
          adapter,
          source,
          text,
        });
        try {
          await sendAccessDeniedReply({
            bot,
            adapter,
            threadId: thread.id,
          });
        } catch (error) {
          console.warn('[bot] access-denied reply failed:', error);
        }
        return;
      }
    } else {
      await clearAccessDeniedSession(source);
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
