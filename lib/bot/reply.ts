import { getConfig } from '@/lib/core/kv/config';
import { parseSuggestedFollowUps } from '@/lib/chat/suggested-follow-up';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import {
  ADAPTER_NAMES,
  type AdapterName,
  type ChannelsConfig,
} from '@/types/config/channels';
import type { ChatSource } from '@/types/workflow';
import { Actions, Button, Card, CardText, type Chat } from 'chat';
import { createBaseBotFromConfig, getBaseBot } from './core';
import { recordAdapterReplyContext } from './reply-context';

const logger = createLogger('bot.reply');
const SUGGESTED_FOLLOW_UP_ACTION_ID = 'agentboster_follow_up';

function normalizeAllowedUserIds(value?: string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function getScheduledBroadcastTargets(channels?: ChannelsConfig) {
  const targets: Array<{ adapter: AdapterName; userId: string }> = [];

  for (const adapter of ADAPTER_NAMES) {
    const adapterConfig = channels?.[adapter];
    if (!adapterConfig?.enabled) {
      continue;
    }

    const userIds = normalizeAllowedUserIds(adapterConfig.allowed_author_ids);
    for (const userId of userIds) {
      targets.push({
        adapter,
        userId,
      });
    }
  }

  return targets;
}

async function sendScheduledDirectMessage(input: {
  bot: Chat;
  adapter: AdapterName;
  userId: string;
  text: string;
}): Promise<boolean> {
  try {
    const targetAdapter = input.bot.getAdapter(input.adapter);
    if (!targetAdapter.openDM) {
      throw new Error(
        `Adapter "${input.adapter}" does not support direct messages`,
      );
    }

    const dmThreadId = await targetAdapter.openDM(input.userId);
    await targetAdapter.postMessage(dmThreadId, {
      markdown: input.text,
    });
    return true;
  } catch (error) {
    logger.warn('reply:scheduled_dm_failed', {
      adapter: input.adapter,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function sendScheduledSourceReply(
  text: string,
  config: AppConfig,
): Promise<boolean> {
  const targets = getScheduledBroadcastTargets(config.channels);
  if (targets.length === 0) {
    return false;
  }

  const bot = await createBaseBotFromConfig(config);
  let deliveredCount = 0;

  for (const target of targets) {
    const sent = await sendScheduledDirectMessage({
      bot,
      adapter: target.adapter,
      userId: target.userId,
      text,
    });

    if (sent) {
      deliveredCount += 1;
    }
  }

  logger.info('reply:scheduled_broadcast', {
    targetCount: targets.length,
    deliveredCount,
  });

  return deliveredCount > 0;
}

function buildSuggestedFollowUpCard(text: string) {
  const followUps = parseSuggestedFollowUps(text);
  if (!followUps) {
    return null;
  }

  const cardText = followUps.textWithoutQuestions || text;
  return {
    card: Card({
      children: [
        CardText(cardText),
        Actions(
          followUps.questions.map((question) =>
            Button({
              id: SUGGESTED_FOLLOW_UP_ACTION_ID,
              label: question,
              value: question,
            }),
          ),
        ),
      ],
    }),
    fallbackText: text,
  };
}

async function postAdapterReply(input: {
  adapter: ReturnType<Chat['getAdapter']>;
  source: Extract<ChatSource, { type: 'im' }>;
  text: string;
}) {
  const suggestedFollowUpCard = buildSuggestedFollowUpCard(input.text);
  let sent: Awaited<ReturnType<typeof input.adapter.postMessage>>;
  if (suggestedFollowUpCard) {
    try {
      sent = await input.adapter.postMessage(input.source.threadId, {
        card: suggestedFollowUpCard.card,
        fallbackText: input.text,
      });
    } catch {
      sent = await input.adapter.postMessage(input.source.threadId, {
        markdown: input.text,
      });
    }
  } else {
    sent = await input.adapter.postMessage(input.source.threadId, {
      markdown: input.text,
    });
  }

  await recordAdapterReplyContext(input.source, sent.id, input.text);
  return sent;
}

export async function sendAdapterSourceReply(
  source: ChatSource,
  text: string,
): Promise<boolean> {
  const content = text.trim();
  if (source.type !== 'im' || content.length === 0) {
    return false;
  }

  try {
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);
    await postAdapterReply({
      adapter,
      source,
      text: content,
    });
    return true;
  } catch (error) {
    logger.warn('reply:failed', {
      adapter: source.adapter,
      threadId: source.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteAdapterSourceMessage(
  source: ChatSource,
  messageId: string,
): Promise<boolean> {
  if (source.type !== 'im' || !messageId) {
    return false;
  }

  try {
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);
    await adapter.deleteMessage(source.threadId, messageId);
    return true;
  } catch (error) {
    logger.warn('reply:delete_failed', {
      adapter: source.adapter,
      threadId: source.threadId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Telegram typing indicator lasts ~5s; refresh at this interval */
const TYPING_REFRESH_MS = 4500;
/** Minimum text length change before editing the message */
const EDIT_MIN_DELTA = 20;
/** Maximum time (ms) between edits to keep the output feeling live */
const EDIT_MAX_INTERVAL_MS = 3000;

export async function streamAdapterSourceReply(
  source: ChatSource,
  stream: ReadableStream,
): Promise<boolean> {
  if (source.type !== 'im') return false;

  try {
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);

    // Start typing indicator
    const startTyping = async () => {
      try {
        await adapter.startTyping(source.threadId);
      } catch {
        // Non-critical
      }
    };

    await startTyping();
    const typingTimer = setInterval(startTyping, TYPING_REFRESH_MS);

    let messageId: string | null = null;
    let lastEditedText = '';
    let lastEditTime = 0;
    let fullText = '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    const tryEditMessage = async () => {
      if (!messageId) return;
      const trimmed = fullText.trim();
      if (!trimmed || trimmed === lastEditedText) return;

      const now = Date.now();
      const lengthDelta = trimmed.length - lastEditedText.length;
      const timeDelta = now - lastEditTime;

      if (lengthDelta < EDIT_MIN_DELTA && timeDelta < EDIT_MAX_INTERVAL_MS)
        return;

      try {
        await adapter.editMessage(source.threadId, messageId, {
          markdown: trimmed,
        });
        await recordAdapterReplyContext(source, messageId, trimmed);
        lastEditedText = trimmed;
        lastEditTime = now;
      } catch {
        // edit may fail if message unchanged or rate-limited; ignore
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value instanceof Uint8Array) {
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const rawData = trimmed.startsWith('data:')
              ? trimmed.slice(5).trim()
              : trimmed;
            if (!rawData || rawData === '[DONE]') continue;

            try {
              const chunkText = extractTextFromChunk(JSON.parse(rawData));
              if (chunkText) {
                fullText += chunkText;

                // First chunk → post initial message
                if (!messageId) {
                  const posted = await adapter.postMessage(source.threadId, {
                    markdown: fullText.trim(),
                  });
                  messageId = posted.id;
                  await recordAdapterReplyContext(
                    source,
                    posted.id,
                    fullText.trim(),
                  );
                  lastEditedText = fullText.trim();
                  lastEditTime = Date.now();
                } else {
                  await tryEditMessage();
                }
              }
            } catch {
              continue;
            }
          }
          continue;
        }

        // Non-Uint8Array chunks (already parsed objects)
        const chunkText = extractTextFromChunk(value);
        if (chunkText) {
          fullText += chunkText;

          if (!messageId) {
            const posted = await adapter.postMessage(source.threadId, {
              markdown: fullText.trim(),
            });
            messageId = posted.id;
            await recordAdapterReplyContext(source, posted.id, fullText.trim());
            lastEditedText = fullText.trim();
            lastEditTime = Date.now();
          } else {
            await tryEditMessage();
          }
        }
      }

      // Flush remaining buffered data
      buffered += decoder.decode();
      for (const line of buffered.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const rawData = trimmed.startsWith('data:')
          ? trimmed.slice(5).trim()
          : trimmed;
        if (!rawData || rawData === '[DONE]') continue;
        try {
          const chunkText = extractTextFromChunk(JSON.parse(rawData));
          if (chunkText) fullText += chunkText;
        } catch {
          continue;
        }
      }

      // Final edit with complete text
      const finalText = fullText.trim();
      const suggestedFollowUpCard = buildSuggestedFollowUpCard(finalText);

      if (messageId && suggestedFollowUpCard) {
        try {
          const edited = await adapter.editMessage(source.threadId, messageId, {
            card: suggestedFollowUpCard.card,
            fallbackText: suggestedFollowUpCard.fallbackText,
          });
          await recordAdapterReplyContext(source, edited.id, finalText);
        } catch {
          await postAdapterReply({
            adapter,
            source,
            text: finalText,
          });
        }
      } else if (messageId && finalText && finalText !== lastEditedText) {
        try {
          await adapter.editMessage(source.threadId, messageId, {
            markdown: finalText,
          });
          await recordAdapterReplyContext(source, messageId, finalText);
        } catch {
          // ignore
        }
      }

      // If we never got any text, send a fallback
      if (!messageId && finalText) {
        await postAdapterReply({
          adapter,
          source,
          text: finalText,
        });
      }
    } finally {
      clearInterval(typingTimer);
    }

    return true;
  } catch (error) {
    logger.warn('stream_reply:failed', {
      adapter: source.adapter,
      threadId: source.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function extractTextFromChunk(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const payload = chunk as Record<string, unknown>;
  if (payload.type === 'text-delta') {
    const delta = payload.delta ?? payload.textDelta;
    return typeof delta === 'string' ? delta : '';
  }
  if (payload.type === 'text') {
    return typeof payload.text === 'string' ? payload.text : '';
  }
  return '';
}

export async function sendRoutedSourceReply(
  source: ChatSource,
  text: string,
): Promise<boolean> {
  const content = text.trim();
  if (content.length === 0) {
    return false;
  }

  if (source.type === 'scheduled') {
    const config = await getConfig();
    return sendScheduledSourceReply(content, config);
  }

  return sendAdapterSourceReply(source, content);
}

export { SUGGESTED_FOLLOW_UP_ACTION_ID };
