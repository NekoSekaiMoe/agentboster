import { resolveLanguageModel } from '@/lib/ai';
import { modelMessagesToPrompt } from '@/lib/chat/message-utils';
import type { AppConfig } from '@/types/config';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { type ModelMessage, generateText } from 'ai';
import { DEFAULT_SLIDING_WINDOW_ROUNDS } from '../config';
import {
  SUMMARY_PROMPT_INITIAL,
  SUMMARY_PROMPT_UPDATE,
} from '../compaction-core';
import {
  buildCompressionConversationMessages,
  createSummaryModelMessage,
} from '../context';
import type { CompressResult } from '../types';
import { estimatePromptTokens } from '../compaction-core';

function formatConversation(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .flatMap((part) =>
                'text' in part && typeof part.text === 'string'
                  ? [part.text]
                  : [],
              )
              .join('');
      return `[${message.role}] ${text}`;
    })
    .join('\n\n');
}

interface Turn {
  start: number;
  end: number;
}

function identifyTurns(messages: ModelMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    turns.push({ start: i, end: messages.length });
  }
  for (let i = 0; i < turns.length - 1; i++) {
    turns[i].end = turns[i + 1].start;
  }
  return turns;
}

function keepSlidingWindow(
  messages: ModelMessage[],
  rounds: number,
): ModelMessage[] {
  if (rounds <= 0) return [];
  if (messages.length === 0) return [];

  const turns = identifyTurns(messages);
  if (turns.length === 0) return messages.slice(-rounds * 2);

  const recentTurns = turns.slice(-rounds);
  if (recentTurns.length === 0) return [];

  const startIdx = recentTurns[0].start;
  return messages.slice(startIdx);
}

function selectHeadTail(
  messages: ModelMessage[],
  contextLimit: number,
  maxOutputTokens: number,
): { head: ModelMessage[]; tail: ModelMessage[] } {
  if (messages.length === 0) return { head: [], tail: [] };

  const usableBudget = Math.max(
    2_000,
    Math.min(8_000, Math.floor((contextLimit - maxOutputTokens) * 0.25)),
  );

  const turns = identifyTurns(messages);
  if (turns.length <= 2) {
    return { head: [], tail: messages };
  }

  const tailTurns = turns.slice(-2);
  const tailStartIdx = tailTurns[0].start;
  let tailTokens = 0;
  for (let i = tailStartIdx; i < messages.length; i++) {
    tailTokens += estimatePromptTokens([messages[i]]);
  }

  if (tailTokens <= usableBudget) {
    return {
      head: messages.slice(0, tailStartIdx),
      tail: messages.slice(tailStartIdx),
    };
  }

  const halfBudget = Math.floor(usableBudget / 2);
  let accumulated = 0;
  let splitIdx = tailStartIdx;
  for (let i = tailStartIdx; i < messages.length; i++) {
    accumulated += estimatePromptTokens([messages[i]]);
    if (accumulated > halfBudget) {
      splitIdx = i;
      break;
    }
  }

  return {
    head: messages.slice(0, splitIdx),
    tail: messages.slice(splitIdx),
  };
}

function buildSummaryPrompt(
  headMessages: ModelMessage[],
  previousSummary?: string,
): string {
  const context = formatConversation(headMessages);

  if (previousSummary) {
    return `${SUMMARY_PROMPT_UPDATE}

<previous-summary>
${previousSummary}
</previous-summary>

<conversation-history>
${context}
</conversation-history>`;
  }

  return `${SUMMARY_PROMPT_INITIAL}

<conversation-history>
${context}
</conversation-history>`;
}

export async function generateCompressedContext(input: {
  sessionId: string;
  config: AppConfig;
  slidingWindowRounds?: number;
  previousSummary?: string;
  useTurnBasedSelection?: boolean;
}): Promise<CompressResult> {
  'use step';

  const modelMessages = await buildCompressionConversationMessages(
    input.sessionId,
  );
  const rounds = input.slidingWindowRounds ?? DEFAULT_SLIDING_WINDOW_ROUNDS;
  const modelId = input.config.models?.model;

  if (!modelId) {
    throw new Error('No model configured for compression.');
  }

  if (modelMessages.length === 0) {
    return {
      summaryText: '',
      compressedMessages: [],
    };
  }

  const maxOutput = input.config.models?.max_output_tokens ?? 65536;
  const contextLimit = input.config.models?.context_limit ?? 200000;

  let headMessages: ModelMessage[];
  let tailMessages: ModelMessage[];

  if (input.useTurnBasedSelection) {
    const selection = selectHeadTail(modelMessages, contextLimit, maxOutput);
    headMessages = selection.head;
    tailMessages = selection.tail;
  } else {
    headMessages = modelMessages;
    tailMessages = keepSlidingWindow(modelMessages, rounds);
  }

  if (headMessages.length === 0) {
    return {
      summaryText: '',
      compressedMessages: modelMessagesToPrompt(modelMessages),
    };
  }

  const summaryPrompt = buildSummaryPrompt(headMessages, input.previousSummary);

  const result = await generateText({
    model: resolveLanguageModel(modelId, input.config),
    prompt: summaryPrompt,
    maxOutputTokens: Math.min(maxOutput, 1024),
  });

  const summaryText = result.text.trim();
  const compressedMessages: LanguageModelV3Prompt = modelMessagesToPrompt([
    createSummaryModelMessage(summaryText),
    ...tailMessages,
  ]);

  return {
    summaryText,
    compressedMessages,
  };
}

export { keepSlidingWindow, identifyTurns, selectHeadTail };
