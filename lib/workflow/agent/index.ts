import {
  type SerializedMessageForDB,
  modelMessagesToPrompt,
  serializeSystemMessage,
  serializeUserMessage,
  toModelMessage,
} from '@/lib/chat/message-utils';
import { parseProviderScopedModelId } from '@/lib/ai';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { ChatSource, UserMessagePart } from '@/types/workflow';
import { DurableAgent } from '@workflow/ai/agent';
import type { ModelMessage, StepResult, ToolSet } from 'ai';
import { getWorkflowMetadata } from 'workflow';
import { DEFAULT_MAIN_MAX_STEPS, DEFAULT_THRESHOLD_TO_SUMMARY } from './config';
import { instructionHookBuilder } from './hooks';
import {
  createWritable,
  writeMessageMetadata,
  writeStreamClose,
  writeStreamError,
  writeUserMessageMarker,
} from './sender/writers';
import { buildSystemPrompt } from './steps/build-prompt';
import {
  compactAndPersistSummaryStep,
  finalizeRunStep,
  initializeRunSessionStep,
  persistStepDeltaAndUsageStep,
} from './steps/persist';
import {
  createModelResolver,
  resolveAgentProviderOptions,
} from './steps/resolve-model';
import { buildAgentTools } from './tools';
import { sanitizeToolName } from './tools/tool-name-guard';
import { getTokenUsageTotal } from './types';
import {
  MAIN_AGENT_NAME,
  getMainAgentModelId,
  getMainAgentTemperature,
} from './utils/agent-config';
import { estimatePromptTokens } from './utils/estimateTokens';
import {
  resolveModelContextLimit,
  resolveModelMaxOutputTokens,
} from './utils/model-context';
import { evaluateCompactionNeed } from './utils/shouldCompress';

const logger = createLogger('workflow.agent');

type QueuedInstruction =
  | {
      type: 'user-message';
      message: string;
      parts?: UserMessagePart[];
      uiMessageId?: string;
    }
  | {
      type: 'system-message';
      message: string;
    }
  | {
      type: 'control';
      command: 'compact' | 'cancel';
      reason?: string;
    };

function mapInstructionMessages(
  sessionId: string,
  instructions: QueuedInstruction[],
  options?: {
    modelId?: string | null;
    allowFileParts?: boolean;
  },
): {
  promptMessages: ModelMessage[];
  persistedMessages: SerializedMessageForDB[];
  forceCompact: boolean;
  cancelRequested: boolean;
} {
  const promptMessages: ModelMessage[] = [];
  const persistedMessages: SerializedMessageForDB[] = [];
  let forceCompact = false;
  let cancelRequested = false;

  for (const instruction of instructions) {
    if (instruction.type === 'control') {
      if (instruction.command === 'compact') {
        forceCompact = true;
      }
      if (instruction.command === 'cancel') {
        cancelRequested = true;
      }
      continue;
    }

    if (instruction.type === 'user-message') {
      const persistedMessage = serializeUserMessage({
        sessionId,
        uiMessageId: instruction.uiMessageId ?? null,
        text: instruction.message,
        parts: instruction.parts,
      });
      const promptMessage = toModelMessage(
        {
          role: 'user',
          payload: persistedMessage.payload,
        },
        {
          modelId: options?.modelId,
          allowFileParts: options?.allowFileParts,
        },
      );

      if (promptMessage) {
        promptMessages.push(promptMessage);
      }
      persistedMessages.push(persistedMessage);
      continue;
    }

    promptMessages.push({ role: 'system', content: instruction.message });
    persistedMessages.push(
      serializeSystemMessage({
        sessionId,
        text: instruction.message,
        metadata: {
          type: 'instruction',
        },
      }),
    );
  }

  return {
    promptMessages,
    persistedMessages,
    forceCompact,
    cancelRequested,
  };
}

function buildStepDebugLog(step: StepResult<ToolSet>) {
  return {
    stepNumber: step.stepNumber,
    finishReason: step.finishReason,
    text: step.text,
    reasoningText: step.reasoningText,
    usage: {
      inputTokens: step.usage.inputTokens,
      outputTokens: step.usage.outputTokens,
      totalTokens: step.usage.totalTokens,
    },
    toolCalls: step.toolCalls.map((toolCall) => ({
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      dynamic: 'dynamic' in toolCall ? toolCall.dynamic : false,
      invalid: 'invalid' in toolCall ? toolCall.invalid : false,
      error: 'error' in toolCall ? toolCall.error : undefined,
    })),
    toolResults: step.toolResults.map((toolResult) => ({
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      input: toolResult.input,
      output: toolResult.output,
      dynamic: 'dynamic' in toolResult ? toolResult.dynamic : false,
      preliminary: toolResult.preliminary,
    })),
  };
}

export async function chatWorkflow(
  initialMessages: ModelMessage[],
  source: ChatSource,
  config: AppConfig,
  sessionId: string,
) {
  'use workflow';

  const { workflowRunId: runId } = getWorkflowMetadata();
  const agentName = MAIN_AGENT_NAME;
  const modelId = getMainAgentModelId(config);
  const temperature = getMainAgentTemperature(config);
  const system = await buildSystemPrompt(config, {
    agentName,
    enableFollowUpSuggestions:
      (source.type === 'web' || source.type === 'im') &&
      (config.chat?.follow_up_enabled ?? config.agentd?.follow_up_enabled) ===
        true,
    responseLocale:
      source.type === 'im'
        ? (source.locale ?? config.language?.bot_locale)
        : undefined,
  });
  const writable = createWritable();
  const tools = await buildAgentTools(config, sessionId, {
    runId,
    agentName,
    allowDelegation: true,
    writable,
  });
  const autoContextLimit = resolveModelContextLimit(
    modelId,
    config.models?.context_limit,
  );
  const contextLimit = autoContextLimit;
  const configuredOutputLimit = config.models?.max_output_tokens;
  const outputLimit = resolveModelMaxOutputTokens(
    modelId,
    configuredOutputLimit,
  );
  const maxSteps = Math.max(
    1,
    config.autonomy?.max_steps ?? DEFAULT_MAIN_MAX_STEPS,
  );
  const instructionQueue: QueuedInstruction[] = [];
  let pendingPersistedInstructions: SerializedMessageForDB[] = [];
  let totalTokensUsed = estimatePromptTokens(
    modelMessagesToPrompt(initialMessages),
  );
  const stepStartedAt = new Map<number, Date>();

  // Resolve the configured provider key for the active model. Used in
  // onStepFinish to build a user-facing error message when a third-party
  // OpenAI-compatible endpoint misbehaves (returns finish_reason "stop"
  // despite emitting tool calls). Falls back to the raw modelId if the
  // provider cannot be resolved.
  const providerName = (() => {
    const parsed = parseProviderScopedModelId(modelId);
    if (parsed.providerName) {
      return parsed.providerName;
    }
    const keys = Object.keys(config.models?.providers ?? {});
    return keys[0] ?? modelId;
  })();

  await initializeRunSessionStep({
    sessionId,
    modelId,
    source,
  });

  for (const message of initialMessages) {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .flatMap((part) =>
                'text' in part && typeof part.text === 'string'
                  ? [part.text]
                  : [],
              )
              .join('');
      if (content.trim().length > 0) {
        await writeUserMessageMarker(content);
      }
    }
  }

  void (async () => {
    try {
      using hook = instructionHookBuilder.create({ token: runId });

      for await (const payload of hook) {
        switch (payload.type) {
          case 'user':
            instructionQueue.push({
              type: 'user-message',
              message: payload.message,
              parts: payload.parts,
              uiMessageId: payload.uiMessageId,
            });
            break;
          case 'system':
            instructionQueue.push({
              type: 'system-message',
              message: payload.message,
            });
            break;
          case 'control':
            instructionQueue.push({
              type: 'control',
              command: payload.command,
              reason: payload.reason,
            });
            break;
        }
      }
    } catch (error) {
      logger.warn('instruction:listen_failed', {
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  logger.info('agent:init', {
    agentName,
    allowDelegation: true,
    toolNames: Object.keys(tools),
  });

  const providerOptions = await resolveAgentProviderOptions(config, modelId);
  const agent = new DurableAgent({
    model: createModelResolver(config, modelId),
    system,
    tools,
    temperature,
    maxOutputTokens: outputLimit,
    providerOptions,
  });

  try {
    const result = await agent.stream({
      messages: initialMessages,
      writable,
      preventClose: true,
      maxSteps,
      collectUIMessages: false,
      experimental_repairToolCall: async ({ toolCall, tools }) => {
        // DurableAgent only invokes this hook on schema-validation failure,
        // not on "tool not found". The empty-name / unknown-name crash is
        // handled by the trap tools registered in buildAgentTools. This hook
        // catches the secondary case where the model produced valid-looking
        // arguments but used a subtly wrong tool name (alias / casing).
        const known = new Set(Object.keys(tools));
        const fixed = sanitizeToolName(toolCall.toolName, known);
        if (fixed && fixed.reason !== 'exact') {
          logger.info('tool:repaired_name', {
            sessionId,
            runId,
            toolCallId: toolCall.toolCallId,
            original: toolCall.toolName,
            repaired: fixed.name,
            reason: fixed.reason,
          });
          return {
            type: 'tool-call' as const,
            toolCallId: toolCall.toolCallId,
            toolName: fixed.name,
            input: toolCall.input,
          };
        }
        return null;
      },
      prepareStep: async ({ messages, stepNumber }) => {
        const startedAt = new Date();
        stepStartedAt.set(stepNumber, startedAt);
        await writeMessageMetadata({
          stepNumber,
          createdAt: startedAt.toISOString(),
        });

        const queued = instructionQueue.splice(0);
        const mappedInstructions = mapInstructionMessages(sessionId, queued, {
          modelId,
          allowFileParts: true,
        });
        pendingPersistedInstructions = mappedInstructions.persistedMessages;

        let nextMessages = messages;
        const shouldForceCompact = mappedInstructions.forceCompact;

        const compactionDecision = evaluateCompactionNeed({
          totalTokensUsed,
          contextLimit,
          maxOutputTokens: outputLimit,
          threshold: DEFAULT_THRESHOLD_TO_SUMMARY,
          force: shouldForceCompact,
        });

        if (compactionDecision.shouldCompress) {
          logger.info('compaction:triggered', {
            sessionId,
            reason: compactionDecision.isOverflow ? 'overflow' : 'threshold',
            totalTokens: compactionDecision.totalTokens,
            contextLimit: compactionDecision.contextLimit,
            usageRatio: compactionDecision.usageRatio.toFixed(2),
          });

          const compressed = await compactAndPersistSummaryStep({
            sessionId,
            config,
            useTurnBasedSelection: true,
          });
          nextMessages = compressed.compressedMessages;
          totalTokensUsed = estimatePromptTokens(nextMessages);

          if (compactionDecision.isOverflow) {
            logger.info('compaction:overflow_recovered', {
              sessionId,
              tokensAfterCompression: totalTokensUsed,
            });
          }
        }

        if (mappedInstructions.promptMessages.length > 0) {
          nextMessages = [
            ...nextMessages,
            ...modelMessagesToPrompt(mappedInstructions.promptMessages),
          ];
        }

        if (mappedInstructions.cancelRequested) {
          throw new Error('Run cancelled by instruction hook.');
        }

        return {
          messages: nextMessages,
        };
      },
      onStepFinish: async (step) => {
        const startedAt = stepStartedAt.get(step.stepNumber) ?? new Date();

        // Detect the third-party-OpenAI-compatible-API bug where the
        // provider returns finish_reason "stop" even though it emitted
        // tool calls. This means the endpoint is being driven through
        // the Responses API (/v1/responses) but does not implement it
        // correctly — tool calls will never execute and the agent loop
        // silently stalls. Surface a back error so the user knows to
        // switch this provider to the OpenAI Legacy (Chat Completions)
        // API in Config > Models.
        if (step.finishReason === 'stop' && step.toolCalls.length > 0) {
          const errorText = `渠道 ${providerName} 不支持 OpenAI 接口，请切换到 OpenAI Legacy。`;
          logger.error('stream:finish_reason_mismatch', {
            sessionId,
            runId,
            providerName,
            stepNumber: step.stepNumber,
            finishReason: step.finishReason,
            toolCallCount: step.toolCalls.length,
          });
          await writeStreamError(errorText);
          throw new Error(errorText);
        }

        try {
          await writeMessageMetadata({
            stepNumber: step.stepNumber,
            createdAt: startedAt.toISOString(),
            finishReason: step.finishReason,
          });

          const usage = await persistStepDeltaAndUsageStep({
            sessionId,
            step,
            persistedInstructions: pendingPersistedInstructions,
            stepCreatedAt: startedAt,
          });
          logger.info('stream:step_finish', {
            sessionId,
            runId,
            ...buildStepDebugLog(step),
          });
          pendingPersistedInstructions = [];
          const actualTokens = getTokenUsageTotal(usage);
          if (actualTokens > 0) {
            totalTokensUsed = actualTokens;
          } else {
            totalTokensUsed += estimatePromptTokens([{ content: step.text }]);
          }
        } finally {
          stepStartedAt.delete(step.stepNumber);
        }
      },
      onError: async ({ error }) => {
        logger.error('stream:error', {
          sessionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    await finalizeRunStep({
      sessionId,
      runId,
      status: 'completed',
    });

    try {
      await writeStreamClose();
    } catch (closeError) {
      logger.warn('stream:close_failed', {
        sessionId,
        runId,
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      });
    }

    return result.messages;
  } catch (error) {
    await finalizeRunStep({
      sessionId,
      runId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      await writeStreamClose();
    } catch (closeError) {
      logger.warn('stream:close_failed', {
        sessionId,
        runId,
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      });
    }

    throw error;
  }
}
