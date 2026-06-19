import { getConfig } from '@/lib/core/kv/config';
import {
  parseSuggestedFollowUps,
  stripFollowUpMarkers,
} from '@/lib/chat/suggested-follow-up';
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
import { postAdapterVoiceReply } from './voice';
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
          followUps.questions.map((question, index) =>
            Button({
              id: SUGGESTED_FOLLOW_UP_ACTION_ID,
              label: question,
              value: String(index),
            }),
          ),
        ),
      ],
    }),
    fallbackText: cardText,
    questions: followUps.questions,
  };
}

/**
 * Strip any follow-up marker block from text for display. Tries structured
 * parsing first (keeps the body before the marker), falls back to a regex
 * strip that removes any bare marker tokens. Guarantees no marker leakage even
 * when the card path fails.
 */
function stripMarkersForDisplay(text: string): string {
  const followUps = parseSuggestedFollowUps(text);
  if (followUps) {
    return followUps.textWithoutQuestions || text;
  }
  return stripFollowUpMarkers(text);
}

async function postAdapterReply(input: {
  adapter: ReturnType<Chat['getAdapter']>;
  source: Extract<ChatSource, { type: 'im' }>;
  text: string;
}) {
  const suggestedFollowUpCard = buildSuggestedFollowUpCard(input.text);
  const displayText = suggestedFollowUpCard
    ? suggestedFollowUpCard.fallbackText
    : stripMarkersForDisplay(input.text);
  const questions = suggestedFollowUpCard?.questions;
  let sent: Awaited<ReturnType<typeof input.adapter.postMessage>>;
  if (suggestedFollowUpCard) {
    try {
      sent = await input.adapter.postMessage(input.source.threadId, {
        card: suggestedFollowUpCard.card,
        fallbackText: displayText,
      });
    } catch {
      sent = await input.adapter.postMessage(input.source.threadId, {
        markdown: displayText,
      });
    }
  } else {
    sent = await input.adapter.postMessage(input.source.threadId, {
      markdown: displayText,
    });
  }

  await recordAdapterReplyContext(
    input.source,
    sent.id,
    displayText,
    questions,
  );
  return sent;
}

// Exported for lib/bot/voice.ts to use as a text fallback when TTS
// synthesis fails or the adapter does not support audio upload.
export { postAdapterReply };

export async function sendAdapterSourceReply(
  source: ChatSource,
  text: string,
): Promise<boolean> {
  const content = text.trim();
  if (source.type !== 'im' || content.length === 0) {
    return false;
  }

  // TTS voice reply branch — when the channel has tts_enabled and the
  // adapter supports audio upload, send a voice message instead of the
  // plain markdown text. postAdapterVoiceReply handles per-adapter
  // fallback to text on its own.
  const config = await getConfig();
  const channelCfg = config.channels?.[source.adapter];
  if (channelCfg?.tts_enabled) {
    return postAdapterVoiceReply(source, content);
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
