import type { StepResult, ToolSet } from 'ai';
import { getWorkflowMetadata } from 'workflow';

import {
  type SerializedMessageForDB,
  normalizeToolOutputForPersistence,
  serializeAssistantMessage,
  serializeSystemMessage,
  serializeToolMessage,
  serializeWorkflowMessage,
} from '@/lib/chat/message-utils';
import {
  getSession,
  saveMessages,
  updateSession,
  upsertPersistedMessage,
} from '@/lib/core/db/chat';
import { nowIso, patchWorkflowRuntime } from '@/lib/core/sandbox/runtime';
import {
  getCurrentSessionSummary,
  writeSummaryFromCompaction,
} from '@/lib/memory';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { ChatSource } from '@/types/workflow';

import { sendSourceReplyStep } from '../sender/bots';
import {
  writeStepEvent,
  writeSystemEvent,
  writeTokenUsage,
} from '../sender/writers';
import {
  type CompressResult,
  type TokenUsage,
  getTokenUsageTotal,
} from '../types';
import { generateCompressedContext } from './compress';

const logger = createLogger('workflow.agent.persist');

function toUsageRecord(step: StepResult<ToolSet>): TokenUsage {
  return {
    inputTokens: step.usage.inputTokens,
    outputTokens: step.usage.outputTokens,
    totalTokens: step.usage.totalTokens,
  };
}

function createStableMessageId(
  runId: string,
  stepNumber: number,
  kind: string,
  index?: number,
) {
  return index === undefined
    ? `${kind}:${runId}:${stepNumber}`
    : `${kind}:${runId}:${stepNumber}:${index}`;
}

function isDeniedToolOutput(value: unknown): value is {
  denied: true;
  approved: false;
  reason?: string;
} {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { denied?: boolean }).denied === true &&
      (value as { approved?: boolean }).approved === false,
  );
}

export async function persistStepDeltaAndUsageStep(input: {
  sessionId: string;
  step: StepResult<ToolSet>;
  persistedInstructions?: SerializedMessageForDB[];
  stepCreatedAt?: Date;
}): Promise<TokenUsage> {
  'use step';

  const { workflowRunId: runId } = getWorkflowMetadata();
  const usage = toUsageRecord(input.step);
  const stepCreatedAt = input.stepCreatedAt ?? new Date();
  const rows: SerializedMessageForDB[] = [
    ...(input.persistedInstructions ?? [])
      .filter((row) => row.role !== 'user')
      .map((row, index) => ({
        ...row,
        uiMessageId:
          row.uiMessageId ??
          createStableMessageId(
            runId,
            input.step.stepNumber,
            'instruction',
            index,
          ),
      })),
  ];

  // All rows produced by a single step (assistant text + each tool call)
  // share the same uiMessageId so that the loader can merge them back
  // into one assistant message. Without this, a step that emits text
  // followed by tool calls would render as two separate messages after
  // a page refresh (the text card and the tool card each with its own
  // action row), which is what users see as "tool card appearing below
  // the regenerate/copy buttons".
  const stepUiMessageId = createStableMessageId(
    runId,
    input.step.stepNumber,
    'assistant',
  );

  if (input.step.text.trim().length > 0) {
    rows.push({
      ...serializeAssistantMessage({
        sessionId: input.sessionId,
        text: input.step.text,
        stepNumber: input.step.stepNumber,
        finishReason: input.step.finishReason,
        usage,
        createdAt: stepCreatedAt,
      }),
      uiMessageId: stepUiMessageId,
    });
  }

  const savedMessageIds: string[] = [];
  for (const row of rows) {
    const saved = await upsertPersistedMessage(row);
    if (saved) {
      savedMessageIds.push(saved.uiMessageId ?? saved.id);
    }
  }
  const session = await getSession(input.sessionId);
  const latestApproval =
    (session?.metadata?.latestApproval as
      | {
          toolCallId?: string;
          status?: string;
          comment?: string | null;
        }
      | undefined) ?? undefined;

  for (const toolCall of input.step.toolCalls) {
    const result = input.step.toolResults.find(
      (item) => item.toolCallId === toolCall.toolCallId,
    );
    const deniedOutput = result ? isDeniedToolOutput(result.output) : false;
    const toolOutput = result
      ? deniedOutput
        ? (result.output.reason ?? 'Execution denied by approval policy.')
        : normalizeToolOutputForPersistence(result.output)
      : undefined;

    const toolApproval =
      latestApproval?.toolCallId === toolCall.toolCallId &&
      (latestApproval.status === 'approved' ||
        latestApproval.status === 'rejected')
        ? {
            id: toolCall.toolCallId,
            approved: latestApproval.status === 'approved',
            reason: latestApproval.comment ?? undefined,
          }
        : undefined;

    await upsertPersistedMessage(
      serializeToolMessage({
        sessionId: input.sessionId,
        // Tool rows share a prefix with the assistant text row of the same
        // step (both start with "<stepUiMessageId>") so the loader can
        // group them back together. The "#tool:<toolCallId>" suffix keeps
        // the (sessionId, uiMessageId) unique constraint satisfied —
        // otherwise two tool rows in the same step would collide.
        uiMessageId: `${stepUiMessageId}#tool:${toolCall.toolCallId}`,
        stepNumber: input.step.stepNumber,
        finishReason: input.step.finishReason,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        toolState: deniedOutput
          ? 'output-denied'
          : result
            ? 'output-available'
            : 'input-available',
        toolApproval,
        toolInput: toolCall.input,
        toolOutput,
        createdAt: stepCreatedAt,
      }),
    );
  }

  const totalTokens =
    (session?.totalTokens ?? 0) + (input.step.usage.totalTokens ?? 0);

  await updateSession(input.sessionId, {
    totalTokens,
    latestTokenUsage: usage,
    metadata: {
      ...(session?.metadata ?? {}),
      contextUsage: {
        totalTokens,
        inputTokens:
          ((
            session?.metadata?.contextUsage as
              | { inputTokens?: unknown }
              | undefined
          )?.inputTokens
            ? getTokenUsageTotal(
                (
                  session?.metadata?.contextUsage as
                    | { inputTokens?: unknown }
                    | undefined
                )?.inputTokens,
              )
            : 0) + getTokenUsageTotal(input.step.usage.inputTokens),
        outputTokens:
          ((
            session?.metadata?.contextUsage as
              | { outputTokens?: unknown }
              | undefined
          )?.outputTokens
            ? getTokenUsageTotal(
                (
                  session?.metadata?.contextUsage as
                    | { outputTokens?: unknown }
                    | undefined
                )?.outputTokens,
              )
            : 0) + getTokenUsageTotal(input.step.usage.outputTokens),
      },
      latestApproval: session?.metadata?.latestApproval ?? null,
    },
  });

  await writeTokenUsage(usage);
  await writeStepEvent({
    stepNumber: input.step.stepNumber,
    finishReason: input.step.finishReason,
    totalTokens: totalTokens,
    inputTokens: input.step.usage.inputTokens,
    outputTokens: input.step.usage.outputTokens,
    messageIds: savedMessageIds,
  });

  // IM replies are posted/edited from inside the workflow via
  // streamImStepReplyStep in lib/workflow/agent/index.ts's onStepFinish.
  // Only send for non-IM sources (e.g. 'scheduled') here.
  const source = session?.metadata?.source as ChatSource | undefined;
  if (input.step.text.trim().length > 0 && source && source.type !== 'im') {
    await sendSourceReplyStep({
      source,
      text: input.step.text,
    });
  }

  return usage;
}

export async function initializeRunSessionStep(input: {
  sessionId: string;
  modelId: string;
  source: ChatSource;
}) {
  'use step';

  const session = await getSession(input.sessionId);

  await updateSession(input.sessionId, {
    model: input.modelId,
    metadata: {
      ...(session?.metadata ?? {}),
      source: input.source,
    },
  });
}

export async function compactAndPersistSummaryStep(input: {
  sessionId: string;
  config: AppConfig;
  useTurnBasedSelection?: boolean;
}): Promise<CompressResult> {
  'use step';

  const current = await getCurrentSessionSummary(input.sessionId);
  const compressed = await generateCompressedContext({
    sessionId: input.sessionId,
    config: input.config,
    slidingWindowRounds: 3,
    previousSummary: current?.content,
    useTurnBasedSelection: input.useTurnBasedSelection ?? true,
  });

  if (compressed.summaryText.length === 0) {
    return compressed;
  }

  if (current?.content !== compressed.summaryText) {
    await writeSummaryFromCompaction({
      sessionId: input.sessionId,
      summaryText: compressed.summaryText,
      createdAt: new Date(),
      metadata: {
        compactedAt: nowIso(),
      },
    });
    await saveMessages([
      serializeSystemMessage({
        sessionId: input.sessionId,
        text: 'Context compacted.',
        metadata: {
          type: 'compaction',
          compactedAt: nowIso(),
        },
        createdAt: new Date(),
      }),
    ]);
  }

  await saveMessages([
    serializeWorkflowMessage({
      sessionId: input.sessionId,
      data: {
        kind: 'message',
        type: 'system-event',
        eventType: 'compact',
        message: 'Context compacted',
      },
      createdAt: new Date(),
    }),
  ]);

  await writeSystemEvent('compact', 'Context compacted');
  return compressed;
}

export async function finalizeRunStep(input: {
  sessionId: string;
  runId: string;
  status: 'completed' | 'stopped' | 'error';
  error?: string;
}) {
  'use step';

  const session = await getSession(input.sessionId);
  if (!session) {
    return;
  }

  if (session.workflowRunId !== input.runId) {
    logger.warn('finalize:skip_stale_run', {
      sessionId: input.sessionId,
      runId: input.runId,
      activeRunId: session.workflowRunId,
      status: input.status,
    });
    return;
  }

  await updateSession(input.sessionId, {
    workflowRunId: null,
    status: input.status === 'error' ? 'error' : input.status,
  });
  await patchWorkflowRuntime(input.sessionId, {
    phase:
      input.status === 'completed'
        ? 'completed'
        : input.status === 'error'
          ? 'error'
          : 'cancelled',
    lastRunId: input.runId,
    stoppedAt: nowIso(),
    lastError: input.error ?? null,
  });

  if (input.error) {
    await saveMessages([
      serializeWorkflowMessage({
        sessionId: input.sessionId,
        data: {
          kind: 'message',
          type: 'system-event',
          eventType: 'error',
          message: input.error,
        },
        createdAt: new Date(),
      }),
    ]);
    await writeSystemEvent('error', input.error);
  }
}
