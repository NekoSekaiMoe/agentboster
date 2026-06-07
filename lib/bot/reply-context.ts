import {
  getSessionByExternalThreadId,
  listSessionsByExternalThreadIds,
} from '@/lib/core/db/chat';
import { get, set } from '@/lib/core/kv';
import {
  buildExternalThreadId,
  type ChatSource,
  type IMChatSource,
} from '@/types/workflow';
import type { AdapterName } from '@/types/config/channels';

const REPLY_CONTEXT_TTL_SECONDS = 60 * 60 * 24 * 30;

type ReplyContextRecord = {
  sessionId: string;
  source: IMChatSource;
  sentMessageId: string;
  sentText?: string;
  createdAt: string;
};

function replyContextKey(adapter: AdapterName, messageId: string): string {
  return `bot:reply-context:${adapter}:${messageId}`;
}

function getExternalThreadIds(source: IMChatSource): string[] {
  return [buildExternalThreadId(source), source.threadId].filter(
    (value, index, values): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      values.indexOf(value) === index,
  );
}

async function resolveSessionId(source: IMChatSource): Promise<string | null> {
  const externalThreadIds = getExternalThreadIds(source);
  if (externalThreadIds.length === 0) {
    return null;
  }

  const direct = await getSessionByExternalThreadId(externalThreadIds[0]);
  if (direct) {
    return direct.id;
  }

  const [legacy] = await listSessionsByExternalThreadIds(externalThreadIds);
  return legacy?.id ?? null;
}

export async function recordAdapterReplyContext(
  source: ChatSource,
  sentMessageId: string | null | undefined,
  sentText?: string,
): Promise<void> {
  if (source.type !== 'im' || !sentMessageId) {
    return;
  }

  const sessionId = await resolveSessionId(source);
  if (!sessionId) {
    return;
  }

  const record: ReplyContextRecord = {
    sessionId,
    source,
    sentMessageId,
    sentText: sentText?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };

  await set(
    replyContextKey(source.adapter, sentMessageId),
    JSON.stringify(record),
    {
      ex: REPLY_CONTEXT_TTL_SECONDS,
    },
  );
}

export async function getAdapterReplyContext(
  adapter: AdapterName,
  sentMessageId: string | null | undefined,
): Promise<ReplyContextRecord | null> {
  if (!sentMessageId) {
    return null;
  }

  const raw = await get(replyContextKey(adapter, sentMessageId));
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReplyContextRecord>;
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.sentMessageId !== 'string' ||
      (parsed.sentText !== undefined && typeof parsed.sentText !== 'string') ||
      !parsed.source ||
      parsed.source.type !== 'im'
    ) {
      return null;
    }

    return parsed as ReplyContextRecord;
  } catch {
    return null;
  }
}
