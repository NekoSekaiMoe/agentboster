import { routeAdapterMessage } from '@/lib/chat/index';
import { buildInlineFollowUpText } from '@/lib/chat/follow-up';
import {
  createSession,
  listSessionsByExternalThreadIds,
  updateSession,
  upsertPersistedMessage,
} from '@/lib/core/db/chat';
import { resolveClawLessUserId } from '@/lib/core/db/im-accounts';
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
import { getAdapterReplyContext } from './reply-context';
import { SUGGESTED_FOLLOW_UP_ACTION_ID } from './reply';

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
  id?: string | null;
  raw?: unknown;
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

/**
 * Determine whether an IM author is authorized to use the bot.
 *
 * A user is authorized if they are either:
 * 1. Listed in the adapter's `allowed_author_ids` config (manual allowlist), or
 * 2. Has an active pairing in the `im_accounts` table (paired via /pair).
 *
 * When neither the allowlist nor im_accounts has any entries for this
 * adapter, all users are allowed (backwards-compatible open mode for
 * existing single-user deployments that haven't set up pairing yet).
 */
async function isImUserAuthorized(
  channels: ChannelsConfig | undefined,
  adapter: AdapterName,
  message: IncomingMessage,
): Promise<boolean> {
  const authorUserId = message.author?.userId?.trim() ?? '';

  // Check manual allowlist first.
  const adapterConfig = channels?.[adapter];
  const allowedIds = adapterConfig?.allowed_author_ids ?? [];
  if (authorUserId && allowedIds.includes(authorUserId)) {
    return true;
  }

  // Check im_accounts pairing.
  if (authorUserId) {
    const clawlessUserId = await resolveClawLessUserId(adapter, authorUserId);
    if (clawlessUserId) {
      return true;
    }
  }

  // Backwards compat: if the adapter has no allowlist AND no users have
  // ever paired via im_accounts for this adapter, allow everyone. This
  // preserves the "open mode" for existing single-user deployments.
  // Once anyone pairs, the gate becomes enforced.
  if (allowedIds.length === 0) {
    return true;
  }

  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function getTextFromRawMessage(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return '';
  }

  return (
    (typeof record.text === 'string' ? record.text : '') ||
    (typeof record.caption === 'string' ? record.caption : '') ||
    (typeof record.content === 'string' ? record.content : '')
  ).trim();
}

function getTelegramCompositeMessageId(value: unknown): string | null {
  const record = asRecord(value);
  const chat = asRecord(record?.chat);
  const chatId = chat?.id;
  const messageId = record?.message_id;

  if (
    (typeof chatId !== 'string' && typeof chatId !== 'number') ||
    typeof messageId !== 'number'
  ) {
    return null;
  }

  return `${chatId}:${messageId}`;
}

function extractReplyReference(message: IncomingMessage): {
  messageId: string | null;
  text: string;
} | null {
  const raw = asRecord(message.raw);
  if (!raw) {
    return null;
  }

  const telegramReply = asRecord(raw.reply_to_message);
  if (telegramReply) {
    return {
      messageId: getTelegramCompositeMessageId(telegramReply),
      text: getTextFromRawMessage(telegramReply),
    };
  }

  const discordReply = asRecord(raw.referenced_message);
  if (discordReply) {
    const id = discordReply.id;
    return {
      messageId: typeof id === 'string' ? id : null,
      text: getTextFromRawMessage(discordReply),
    };
  }

  const messageReference = asRecord(raw.message_reference);
  if (messageReference) {
    const id = messageReference.message_id;
    return {
      messageId: typeof id === 'string' ? id : null,
      text: '',
    };
  }

  return null;
}

function buildRoutedParts(input: {
  parts: UserMessagePart[];
  replyText: string;
  text: string;
}): UserMessagePart[] {
  if (!input.replyText || input.text.startsWith('/')) {
    return input.parts;
  }

  const followUpText = buildInlineFollowUpText({
    quoteLabel: '回复的消息',
    quoteText: input.replyText,
    question: input.text,
  });

  return [
    { type: 'text', text: followUpText },
    ...input.parts.filter((part) => part.type !== 'text'),
  ];
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
    messageId: message.id?.trim() || null,
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
    const replyReference = extractReplyReference(message);
    const replyContext = replyReference?.messageId
      ? await getAdapterReplyContext(adapter, replyReference.messageId)
      : null;
    const routedParts = buildRoutedParts({
      parts,
      replyText: replyReference?.text || replyContext?.sentText || '',
      text,
    });

    if (!(await isImUserAuthorized(config?.channels, adapter, message))) {
      const isPaired =
        userId.length > 0 && (await get(`pair:bound:${adapter}:${userId}`));
      const isPairCommand = text.startsWith('/pair ');
      const isStartCommand = text === '/start' || text.startsWith('/start ');
      const isBarePairCode = /^\d{6}$/.test(text);

      if (!isPaired && (isPairCommand || isStartCommand || isBarePairCode)) {
        if (isBarePairCode && routedParts[0]?.type === 'text') {
          routedParts[0] = { type: 'text', text: `/pair ${text}` };
        }
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

    const routedText =
      routedParts[0]?.type === 'text' ? routedParts[0].text : text;

    await routeAdapterMessage({
      adapter,
      origin: thread.channelId ?? thread.id,
      sessionId: replyContext?.sessionId,
      threadId: thread.id,
      messageId: message.id?.trim() || null,
      userId: message.author?.userId ?? null,
      userName: message.author?.userName ?? null,
      locale: config.language?.bot_locale ?? 'auto',
      text: routedText,
      parts: routedParts,
    });
  }

  function dedupKey(thread: { id: string }, message: IncomingMessage): string {
    const messageId = message.id?.trim();
    if (messageId) {
      return `bot:dedup:${thread.id}:${messageId}`;
    }

    const replyReference = extractReplyReference(message);
    const replyMessageId = replyReference?.messageId ?? '';
    return `bot:dedup:${thread.id}:${message.author?.userId ?? ''}:${replyMessageId}:${message.text ?? ''}`;
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

  bot.onAction(SUGGESTED_FOLLOW_UP_ACTION_ID, async (event) => {
    if (!event.threadId) {
      return;
    }

    const adapter = event.adapter.name as AdapterName;
    const source: Extract<ChatSource, { type: 'im' }> = {
      adapter,
      origin: event.threadId,
      threadId: event.threadId,
      messageId: event.messageId,
      type: 'im',
      userId: event.user.userId ?? null,
      userName: event.user.userName ?? null,
    };
    const replyContext = await getAdapterReplyContext(adapter, event.messageId);

    // Resolve the actual follow-up question text. New buttons carry an index
    // ('0'|'1'|'2') into replyContext.followUpQuestions; legacy buttons (issued
    // before the index refactor) carried the full text in value, so fall back
    // to treating value as literal text for backward compatibility.
    let text: string | undefined;
    const rawValue = event.value?.trim();
    if (rawValue && replyContext?.followUpQuestions) {
      const idx = Number.parseInt(rawValue, 10);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < replyContext.followUpQuestions.length
      ) {
        text = replyContext.followUpQuestions[idx]?.trim();
      }
    }
    if (!text) {
      text = rawValue;
    }
    if (!text) {
      return;
    }

    await routeAdapterMessage({
      adapter,
      origin: source.origin,
      sessionId: replyContext?.sessionId,
      threadId: event.threadId,
      messageId: null,
      userId: source.userId,
      userName: source.userName,
      locale: config.language?.bot_locale ?? 'auto',
      text,
      parts: [{ type: 'text', text }],
    });
  });

  return bot;
}
