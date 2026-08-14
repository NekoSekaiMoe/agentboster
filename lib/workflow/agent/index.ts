import {
  type SerializedMessageForDB,
  modelMessagesToPrompt,
  serializeSystemMessage,
  serializeUserMessage,
  toModelMessage,
} from '@/lib/chat/message-utils';
import { parseProviderScopedModelId } from '@/lib/ai';
import { applyClientSpoofOverride } from '@/lib/ai/client-spoof';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { ClientSpoof } from '@/types/config/ai';
import type { ChatSource, UserMessagePart } from '@/types/workflow';
import { DurableAgent } from '@workflow/ai/agent';
import type { ModelMessage, StepResult, ToolSet } from 'ai';
import { getWorkflowMetadata } from 'workflow';
import { start } from 'workflow/api';
import { DEFAULT_MAIN_MAX_STEPS, DEFAULT_THRESHOLD_TO_SUMMARY } from './config';
import { instructionHookBuilder } from './hooks';
import { postRunCleanupWorkflow } from './post-run-cleanup';
import { acquireRunLockStep, releaseRunLockStep } from './workspace-lock';
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
import {
  applyMessageCompat,
  resolveProviderCompat,
} from '@/lib/ai/provider-compat';
import {
  ToolLoopGuard,
  describeLoopTrip,
  inputKeyOf,
  resolveToolLoopLimits,
} from './tool-loop-guard';
import { microcompact, resolveMicrocompactConfig } from './microcompact';
import { sanitizeToolName } from './tools/tool-name-guard';
import { getTokenUsageTotal } from './types';
import {
  MAIN_AGENT_NAME,
  resolveMainAgentModelParams,
} from './utils/agent-config';
import {
  estimatePromptTokens,
  evaluateCompactionNeed,
} from './compaction-core';

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
      command: 'compact' | 'cancel' | 'checkpoint' | 'goal-continue';
      reason?: string;
      /**
       * Label for a checkpoint command. Optional — when omitted the
       * checkpoint is unnamed (auto-labeled with its step number). The
       * label is stored on the session_memories row metadata so the user
       * can later identify / restore a specific checkpoint in the UI.
       */
      label?: string;
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
  checkpointLabel: string | null;
} {
  const promptMessages: ModelMessage[] = [];
  const persistedMessages: SerializedMessageForDB[] = [];
  let forceCompact = false;
  let cancelRequested = false;
  // Most-recent checkpoint label (an explicit `null` means "use auto label").
  // Collected from any checkpoint control instruction in the queue; the
  // workflow applies it after the forced compact lands.
  let checkpointLabel: string | null = null;

  for (const instruction of instructions) {
    if (instruction.type === 'control') {
      if (instruction.command === 'compact') {
        forceCompact = true;
      }
      if (instruction.command === 'cancel') {
        cancelRequested = true;
      }
      if (instruction.command === 'checkpoint') {
        // A checkpoint IS a forced compact that also stamps a label on
        // the resulting session_memories row. Force compact, capture the
        // label, and let the run loop's compact branch handle persistence.
        forceCompact = true;
        checkpointLabel = instruction.label ?? null;
      }
      if (instruction.command === 'goal-continue') {
        // A hidden auto-continuation from the session-goal evaluator
        // (post-run-cleanup.ts → resumeWithMessage). Without a message
        // the resumed run would re-read stale context with no new
        // instruction, so inject a continuation prompt that tells the
        // agent to advance the goal. Persisted as an instruction-marked
        // system message (same treatment as a /system instruction) so
        // the transcript shows why the run resumed.
        const text =
          'The session goal is not met yet. Continue working toward it autonomously: pick the next concrete step that makes verifiable progress toward the goal, and only ask the user for input if you are genuinely blocked.';
        promptMessages.push({ role: 'system', content: text });
        persistedMessages.push(
          serializeSystemMessage({
            sessionId,
            text,
            metadata: {
              type: 'instruction',
            },
          }),
        );
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
    checkpointLabel,
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
  user?: {
    modelPreferences?: { model?: string } | null;
  } | null,
  /**
   * Per-message model override from the chat-box picker. When set, the main
   * agent uses this model id for this run only; subsequent runs fall back
   * to the user preference / global default unless the picker passes it
   * again. Memory extraction inside this workflow deliberately ignores it
   * (passes `undefined` to its own model resolution).
   */
  requestModel?: string | null,
  /**
   * Merged AGENTS.md content from the CLI host (persisted on
   * session.metadata by chatMain). Forwarded to buildSystemPrompt — but
   * only when `source.type === 'cli'`; other sources pass undefined so the
   * stored prompt stays untouched.
   */
  agentsMd?: string,
  /**
   * When true, the workflow drops every state-mutating tool from the
   * registry (writes, shell exec, sandbox, browser mutators). Set by
   * chatMain from the CLI `/plan` toggle so the model can only read,
   * search, and reason — never mutate — until the user approves a plan.
   * False / undefined = normal execution mode.
   */
  planMode?: boolean,
  /**
   * Thinking level from the CLI `/effort` command. Forwarded to
   * resolveAgentProviderOptions, which serializes it into the matching
   * provider-specific reasoning field. 'off' / undefined leaves the
   * provider's default behavior unchanged.
   */
  thinkingLevel?: string,
  /**
   * Experimental client-spoof profile from CLI/Desktop settings. When set,
   * overrides provider `client_spoof` for this workflow run.
   */
  clientSpoof?: ClientSpoof,
  /**
   * Per-message agent/persona name from the Web UI preset picker. When
   * set AND present in `config.agents`, overrides MAIN_AGENT_NAME for
   * this single run so buildSystemPrompt loads the matching
   * system_prompt / model. Unknown / absent names fall back to
   * MAIN_AGENT_NAME — this is intentional so a stale picker value
   * (after an admin renames / deletes a persona) degrades gracefully
   * instead of throwing.
   */
  requestAgent?: string | null,
) {
  'use workflow';

  const effectiveConfig = applyClientSpoofOverride(config, clientSpoof);
  const { workflowRunId: runId } = getWorkflowMetadata();

  // M1: acquire the per-workspace run lock so concurrent runs in the same
  // long-lived container serialize. Best-effort — a missed acquire (no
  // workspace, no preferred node, unreachable agentd) silently degrades to
  // the legacy ephemeral-container path. We DO NOT block waiting: busy →
  // fall back to short-lived containers for this turn.
  const workspaceLockHandle = await acquireRunLockStep(sessionId, runId);
  // Release no matter how the run ends. The outer try/finally below wraps
  // EVERY operation after acquisition (including buildSystemPrompt /
  // buildAgentTools / initializeRunSessionStep / resolveAgentProviderOptions,
  // which previously sat in the gap between acquire and the inner try and
  // could throw without releasing — leaking the lock until its TTL).
  const releaseRunLock = () =>
    releaseRunLockStep(workspaceLockHandle).catch((err) =>
      logger.warn('workspace lock release failed', {
        sessionId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  try {
    // Resolve the persona for this run. Only honor requestAgent when it
    // names a real entry in config.agents — otherwise fall back to main.
    // This is the single place main chat's agentName becomes variable;
    // sub-agent delegation still goes through getAgentModelId and is
    // unaffected.
    const requestedAgentName = requestAgent?.trim();
    const agentName =
      requestedAgentName && effectiveConfig.agents?.[requestedAgentName]
        ? requestedAgentName
        : MAIN_AGENT_NAME;
    const { modelId, temperature, contextLimit, outputLimit } =
      resolveMainAgentModelParams(
        effectiveConfig,
        user,
        // When a persona is selected, its configured model takes precedence
        // over the global default but is still overridden by an explicit
        // per-message picker choice. We surface this by pre-resolving the
        // persona model and passing it as the requestModel fallback — keeps
        // the existing precedence chain intact and avoids forking the
        // resolver.
        requestModel ??
          (agentName !== MAIN_AGENT_NAME
            ? effectiveConfig.agents?.[agentName]?.model
            : undefined),
      );

    // Fetch CLI remote state if session has an online CLI
    let cliRemoteState:
      | { cwd: string; platform: string; hasDisplay: boolean }
      | undefined;
    if (source.type !== 'cli') {
      try {
        const { getCliCapabilities } = await import('@/lib/cli/remote-control');
        const caps = await getCliCapabilities(sessionId);
        if (caps) {
          cliRemoteState = {
            cwd: caps.cwd ?? process.cwd(),
            platform: caps.capabilities.platform,
            hasDisplay: caps.capabilities.hasDisplay,
          };
        }
      } catch {
        // Module or network unavailable
      }
    }

    const system = await buildSystemPrompt(effectiveConfig, {
      agentName,
      enableFollowUpSuggestions:
        (source.type === 'web' || source.type === 'im') &&
        (effectiveConfig.chat?.follow_up_enabled ??
          effectiveConfig.agentd?.follow_up_enabled) === true,
      responseLocale:
        source.type === 'im'
          ? (source.locale ?? effectiveConfig.language?.bot_locale)
          : undefined,
      sessionId,
      // The session owner. Used to load the always-on developer profile
      // (lib/memory/profile.ts) — a stable block of the user's global
      // preferences so the model applies them every turn without the user
      // repeating themselves. We pass this ONLY to read profile data; write
      // paths still go through the writeMemory tool with its own userId.
      userId: 'userId' in source ? (source.userId ?? undefined) : undefined,
      // Inject AGENTS.md content only for CLI sources — it is project-supplied
      // reference data forwarded by the CLI host, never synthesized on the web
      // side. Web/IM sessions have no "local project" to source from.
      agentsMd: source.type === 'cli' ? agentsMd : undefined,
      // Surface plan-mode guidance so the model understands why its action
      // tools are gone. Purely informational; the actual toolset filter
      // happens in buildAgentTools.
      planMode,
      // Team Leader mode (Team Mode III): prompt-level guidance nudging the
      // main agent to decompose complex tasks into subAgent fan-out +
      // barrier/handoff coordination. Driven by autonomy.team_leader config.
      teamLeader: effectiveConfig.autonomy?.team_leader === true,
      // Inject CLI remote state (cwd, platform, hasDisplay) when an online CLI
      // is attached to this session. This tells the LLM it can use local_* tools
      // to control the user's local machine.
      cliRemoteState,
      source,
    });
    const writable = createWritable();
    const tools = await buildAgentTools(effectiveConfig, sessionId, {
      runId,
      agentName,
      allowDelegation: true,
      writable,
      // Pass the session owner's userId so user-scoped tools (e.g. writeMemory)
      // persist data under the right user. Without this, memories are written
      // under 'system' and invisible in the memory tab.
      userId: 'userId' in source ? (source.userId ?? undefined) : undefined,
      // Propagate source so tools can register source-specific capabilities
      // (e.g. local_* tools only when source.type === 'cli').
      source,
      // Plan mode (CLI /plan toggle): drop state-mutating tools.
      planMode,
      // Whether the per-workspace run lock was acquired. agentd-scoped execute
      // tools consult this to honor the "busy → fall back to ephemeral"
      // contract (suppressing workspace_id when the lock wasn't acquired).
      workspaceLockAcquired:
        workspaceLockHandle.workspaceId !== null &&
        workspaceLockHandle.execSessionId !== null,
    });
    const maxSteps = Math.max(
      1,
      effectiveConfig.autonomy?.max_steps ?? DEFAULT_MAIN_MAX_STEPS,
    );
    // Tool-loop circuit breaker (aionrs breakers). Counts consecutive
    // malformed / identical-failure / all-error / cycle rounds and aborts the
    // stream before the model burns max_steps worth of identical retries.
    const toolLoopGuard = new ToolLoopGuard(
      resolveToolLoopLimits(effectiveConfig.autonomy?.tool_loop_limits),
    );
    const instructionQueue: QueuedInstruction[] = [];
    let pendingPersistedInstructions: SerializedMessageForDB[] = [];
    let totalTokensUsed = estimatePromptTokens(
      modelMessagesToPrompt(initialMessages),
    );
    const stepStartedAt = new Map<number, Date>();
    // Monotonic counter for completed steps. @workflow/ai's doStreamStep stamps
    // every StepResult.stepNumber with a hardcoded 0 (stream-text-iterator.js
    // increments a local `stepNumber` but never writes it back onto the step
    // object passed to onStepFinish). Relying on step.stepNumber here makes
    // persistStepDeltaAndUsageStep generate the same `assistant:<runId>:0`
    // uiMessageId for every step of a multi-step turn, so upsert's
    // onConflictDoUpdate overwrites earlier steps — including their reasoning
    // parts — leaving only the final step's content after a page refresh
    // (reported as "first thinking disappears on reload").
    let completedStepCount = 0;

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
      const keys = Object.keys(effectiveConfig.models?.providers ?? {});
      return keys[0] ?? modelId;
    })();

    // Resolve the provider's message-compat flags once (aionrs ProviderCompat).
    // Applied in prepareStep to normalize the prompt before each model call —
    // strips orphan tool calls/results, merges adjacent assistant turns,
    // enforces user/assistant alternation, etc. Defaults come from the
    // provider format; users override individual flags via `compat`.
    const providerConfigForCompat =
      effectiveConfig.models?.providers?.[providerName];
    const providerCompat = providerConfigForCompat
      ? resolveProviderCompat(
          providerConfigForCompat.format,
          providerConfigForCompat.compat,
        )
      : undefined;

    // Resolve microcompact config once (aionrs compact/micro.rs). Runs in
    // prepareStep before the autocompact threshold check to fold old tool
    // results cheaply (no LLM call) before paying for a summary.
    const microcompactConfig = resolveMicrocompactConfig(
      effectiveConfig.autonomy?.microcompact,
    );

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
                // Forward the optional checkpoint label so named checkpoints
                // survive the queue. Without this, requestCheckpoint's label
                // is dropped here and mapInstructionMessages() always sees
                // undefined → the checkpoint degrades to an anonymous compact.
                ...(payload.label ? { label: payload.label } : {}),
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

    const providerOptions = await resolveAgentProviderOptions(
      effectiveConfig,
      modelId,
      thinkingLevel,
    );
    const agent = new DurableAgent({
      model: createModelResolver(effectiveConfig, modelId),
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

          // Microcompact (aionrs compact/micro.rs): fold old tool-result
          // content into a placeholder without an LLM call, keeping the most
          // recent N intact. Runs before the autocompact threshold check so the
          // token estimate reflects the folded state; if this alone brings us
          // back under budget, we skip the expensive LLM summarization entirely.
          // Only ModelMessage[] prompts can be folded.
          if (Array.isArray(nextMessages)) {
            const folded = microcompact(
              nextMessages as ModelMessage[],
              microcompactConfig,
            );
            if (folded.result.ran) {
              nextMessages = folded.messages as typeof nextMessages;
              // Re-estimate tokens after folding so the threshold check below
              // sees the lighter prompt.
              totalTokensUsed = estimatePromptTokens(
                modelMessagesToPrompt(folded.messages),
              );
            }
          }

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
              config: effectiveConfig,
              useTurnBasedSelection: true,
              checkpointLabel: mappedInstructions.checkpointLabel,
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

          // Apply provider message-compat normalization (aionrs ProviderCompat):
          // repair orphan tool blocks, merge adjacent same-role messages,
          // enforce alternation. Cheap no-op fast path when nothing is enabled.
          // Only ModelMessage[] prompts can be normalized; if the AI SDK passed
          // us an already-low-level LanguageModelV3Prompt we leave it untouched.
          let finalMessages: typeof nextMessages = nextMessages;
          if (providerCompat && Array.isArray(nextMessages)) {
            const maybeModelMessages = nextMessages as unknown[];
            if (
              maybeModelMessages.every(
                (m) =>
                  m !== null &&
                  typeof m === 'object' &&
                  'role' in (m as object),
              )
            ) {
              finalMessages = applyMessageCompat(
                nextMessages as ModelMessage[],
                providerCompat,
              ) as typeof nextMessages;
            }
          }

          return {
            messages: finalMessages,
          };
        },
        onStepFinish: async (step) => {
          // step.stepNumber is always 0 (see comment above completedStepCount),
          // so we cannot rely on it. prepareStep's ({ stepNumber }) callback
          // receives the correct value and stores the step's start time under
          // that key in stepStartedAt; since steps complete in order, the
          // current completedStepCount matches the key prepareStep used for
          // this step.
          const realStepNumber = completedStepCount;
          const startedAt = stepStartedAt.get(realStepNumber) ?? new Date();

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
              stepNumber: realStepNumber,
              finishReason: step.finishReason,
              toolCallCount: step.toolCalls.length,
            });
            await writeStreamError(errorText);
            throw new Error(errorText);
          }

          // Tool-loop circuit-breaker check. Observe this step's tool round
          // (input + outcome per call) and abort early if the model is stuck
          // in a malformed / identical-failure / all-error / cycle pattern.
          // Borrowed from aionrs breakers — see tool-loop-guard.ts.
          if (step.toolCalls.length > 0) {
            const observed = step.toolCalls.map((tc) => {
              // Pair the call with its result (if any) to learn the outcome.
              const result = step.toolResults.find(
                (tr) => tr.toolCallId === tc.toolCallId,
              );
              const malformed = 'invalid' in tc ? Boolean(tc.invalid) : false;
              const errored =
                malformed ||
                Boolean(result && 'error' in result && result.error);
              return {
                name: tc.toolName,
                inputKey: inputKeyOf(tc.input),
                malformed,
                error: errored,
              };
            });
            const loopSnap = toolLoopGuard.observe(observed);
            const tripReason = toolLoopGuard.tripReason();
            if (tripReason) {
              const errorText = describeLoopTrip(tripReason, loopSnap);
              logger.error('stream:tool_loop_breaker', {
                sessionId,
                runId,
                tripReason,
                ...loopSnap,
                providerName,
                stepNumber: realStepNumber,
              });
              await writeStreamError(errorText);
              throw new Error(`[tool_loop_breaker:${tripReason}] ${errorText}`);
            }
          }

          try {
            const completedAt = new Date();
            await writeMessageMetadata({
              stepNumber: realStepNumber,
              createdAt: startedAt.toISOString(),
              finishReason: step.finishReason,
            });

            const usage = await persistStepDeltaAndUsageStep({
              sessionId,
              step: { ...step, stepNumber: realStepNumber },
              persistedInstructions: pendingPersistedInstructions,
              stepCreatedAt: startedAt,
              stepCompletedAt: completedAt,
            });
            logger.info('stream:step_finish', {
              sessionId,
              runId,
              ...buildStepDebugLog({ ...step, stepNumber: realStepNumber }),
            });
            pendingPersistedInstructions = [];

            const actualTokens = getTokenUsageTotal(usage);
            if (actualTokens > 0) {
              totalTokensUsed = actualTokens;
            } else {
              totalTokensUsed += estimatePromptTokens([{ content: step.text }]);
            }
          } finally {
            stepStartedAt.delete(realStepNumber);
            completedStepCount += 1;
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

      // Close the UI stream immediately. The client receives `finish` as
      // soon as the run is marked completed — semantically the right
      // moment, since everything below produces no stream output. See the
      // note under the cleanup spawn for why this was previously blocked
      // on cleanup completing.
      try {
        await writeStreamClose();
      } catch (closeError) {
        logger.warn('stream:close_failed', {
          sessionId,
          runId,
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        });
      }

      // Post-run finalization (memory extraction + skill distillation +
      // resource cleanup) runs in an INDEPENDENT workflow run, spawned
      // fire-and-forget. The client has already received `finish` above.
      //
      // History: this used to be deferred to afterResponse() — a queue
      // drained by the host when the workflow's readable stream closed.
      // That worked when POST /api/ai kept the SSE connection open for
      // the whole run. With fire-and-forget, /api/ai returns immediately
      // and no host process reliably drains that queue, so afterResponse()
      // was removed and cleanup was moved INLINE as awaited workflow
      // steps. The inline-await form was correct for durability but
      // reintroduced client-visible latency: extractMemoriesFromSession
      // and maybeDistillSkillFromSession issue LLM calls that can take
      // seconds-to-minutes, and the client blocked on `finish` until
      // they completed (despite producing no stream output).
      //
      // The fix: spawn a separate workflow run (postRunCleanupWorkflow)
      // and do NOT await it beyond runId resolution. The Queue Service
      // schedules the cleanup independently; chatWorkflow returns as
      // soon as the spawn call resolves with a runId. This restores the
      // original "never blocks the reply" semantics of afterResponse(),
      // just on a durable carrier. Nesting pattern mirrors
      // `scheduledTaskWorkflow`, which is similarly `start()`-ed from
      // inside another workflow (see
      // lib/workflow/agent/tools/tasks/schedule.ts).
      //
      // The `start()` call itself returns once the run is created (runId
      // assigned); subsequent step execution is driven by the Queue
      // Service, not by the caller awaiting its completion.
      //
      // Best-effort: even if the spawn fails, the chat run is already
      // completed and the client has already seen `finish`, so we only
      // log. The cleanup workflow internally wraps each step so a
      // failure in one cannot fail the run.
      //
      // userId is forwarded only for interactive sessions — scheduled
      // sessions still spawn the workflow (for resource cleanup) but
      // postRunCleanupWorkflow skips memory + skills when userId is
      // absent OR sourceType === 'scheduled'. Resource cleanup always
      // runs regardless, so we must not short-circuit the spawn here
      // based on userId — that would skip cleanupResourcesStep too.
      // '?? undefined' normalizes the string | null union on
      // ChatSource.userId to the optional string the workflow expects.
      const interactiveUserId =
        source.type !== 'scheduled' && 'userId' in source
          ? (source.userId ?? undefined)
          : undefined;
      try {
        await start(postRunCleanupWorkflow, [
          {
            sessionId,
            userId: interactiveUserId,
            config: effectiveConfig,
            user,
            sourceType: source.type,
            // Resolve workspaceId at this host boundary (from the run lock
            // handle, which read it off the session row at acquire time) so
            // the post-run extractMemories step doesn't touch the DB. Use
            // resolvedWorkspaceId — populated even when the lock itself
            // wasn't acquired — so memory extraction for a workspace-scoped
            // session never falls back to the global layer.
            workspaceId: workspaceLockHandle.resolvedWorkspaceId,
            // Forward the chat run id so evaluateGoalStep can resume it
            // when the goal evaluator decides to issue a hidden
            // continuation.
            runId,
          },
        ]);
        logger.info('post-run-cleanup:spawned', {
          sessionId,
          runId,
          scheduled: source.type === 'scheduled',
        });
      } catch (err) {
        logger.warn('post-run-cleanup:spawn_failed', {
          sessionId,
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return result.messages;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      const terminalStatus = /timeout/i.test(errorText)
        ? ('timeout' as const)
        : /cancel/i.test(errorText)
          ? ('stopped' as const)
          : ('error' as const);
      await finalizeRunStep({
        sessionId,
        runId,
        status: terminalStatus,
        error: errorText,
      });

      try {
        await writeStreamClose();
      } catch (closeError) {
        logger.warn('stream:close_failed', {
          sessionId,
          runId,
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        });
      }

      throw error;
    }
  } finally {
    // Release the workspace run lock on EVERY exit path, including throws
    // in the gap between acquire and the inner try (buildSystemPrompt,
    // buildAgentTools, initializeRunSessionStep, resolveAgentProviderOptions).
    // The success/catch paths above previously each called releaseRunLock()
    // inline; that was moved here so the release is path-independent.
    await releaseRunLock();
  }
}
