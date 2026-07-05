import { createLogger } from '@/lib/utils/logger';
import { buildSystemPrompt } from '@/lib/workflow/agent/steps/build-prompt';
import {
  createModelResolver,
  resolveAgentProviderOptions,
} from '@/lib/workflow/agent/steps/resolve-model';
import {
  getAgentModelId,
  getAgentTemperature,
  getDelegatableAgentNames,
} from '@/lib/workflow/agent/utils/agent-config';
import { DurableAgent } from '@workflow/ai/agent';
import { type ModelMessage, tool } from 'ai';
import { z } from 'zod';
import {
  createWritable,
  writeSubagentBatchEvent,
  writeSubagentEvent,
} from '../../sender/writers';
import { defineBuildInTool } from '../define';

const SUB_AGENT_MAX_STEPS = 12;
const DEFAULT_MAX_PARALLEL_SUBAGENTS = 3;
const logger = createLogger('workflow.agent.tools.sub-agent');

type PersistedSubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface PersistedSubagentJob {
  subagentId: string;
  batchId: string;
  agentName: string;
  task: string;
  status: PersistedSubagentStatus;
  modelId?: string;
  steps?: number;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface PersistedSubagentBatch {
  batchId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  concurrencyLimit: number;
  jobs: string[];
  succeeded: number;
  failed: number;
  cancelled: number;
}

interface PersistedSubagentState {
  batches: Record<string, PersistedSubagentBatch>;
  jobs: Record<string, PersistedSubagentJob>;
}

interface RuntimeSubagentJob {
  subagentId: string;
  batchId: string;
  agentName: string;
  task: string;
  status: PersistedSubagentStatus;
  controller: AbortController;
  promise: Promise<void>;
  modelId?: string;
  steps?: number;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface RuntimeSubagentBatch {
  sessionId: string;
  batchId: string;
  concurrencyLimit: number;
  createdAt: string;
  jobs: Map<string, RuntimeSubagentJob>;
}

const activeSubagentBatches = new Map<string, RuntimeSubagentBatch>();

function createSubagentId(): string {
  return `wf-subagent-${Math.random().toString(36).slice(2, 10)}`;
}

function createBatchId(): string {
  return `wf-subagent-batch-${Math.random().toString(36).slice(2, 10)}`;
}

function getBatchRegistryKey(sessionId: string, batchId: string): string {
  return `${sessionId}:${batchId}`;
}

function getPersistedSubagentState(metadata: unknown): PersistedSubagentState {
  const root =
    metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>)
      : {};
  const raw =
    root.workflowSubagents && typeof root.workflowSubagents === 'object'
      ? (root.workflowSubagents as Record<string, unknown>)
      : {};
  return {
    batches:
      raw.batches && typeof raw.batches === 'object'
        ? (raw.batches as Record<string, PersistedSubagentBatch>)
        : {},
    jobs:
      raw.jobs && typeof raw.jobs === 'object'
        ? (raw.jobs as Record<string, PersistedSubagentJob>)
        : {},
  };
}

async function readPersistedSubagentStateStep(
  sessionId: string,
): Promise<PersistedSubagentState> {
  'use step';

  const { getSession } = await import('@/lib/core/db/chat');
  const session = await getSession(sessionId);
  return getPersistedSubagentState(session?.metadata ?? null);
}

async function writePersistedSubagentStateStep(input: {
  sessionId: string;
  next: PersistedSubagentState;
}): Promise<void> {
  'use step';

  const { getSession, updateSession } = await import('@/lib/core/db/chat');
  const session = await getSession(input.sessionId);
  if (!session) {
    return;
  }

  await updateSession(input.sessionId, {
    metadata: {
      ...(session.metadata ?? {}),
      workflowSubagents: input.next,
    },
  });
}

function getSubagentConcurrencyLimit(
  config: Parameters<typeof getAgentModelId>[0],
  agentName: string,
): number {
  return (
    config.agents?.[agentName]?.max_parallel_subagents ??
    DEFAULT_MAX_PARALLEL_SUBAGENTS
  );
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const maxWorkers = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: maxWorkers }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

function summarizeBatchResults(
  input: {
    concurrencyLimit: number;
    succeeded: number;
    failed: number;
  },
  results: Array<
    | {
        ok: true;
        task: string;
        subagentId: string;
        agentName: string;
        modelId: string;
        steps: number;
        response: string;
      }
    | {
        ok: false;
        task: string;
        agentName: string;
        error: string;
      }
  >,
): string {
  const header = [
    `Batch sub-agent run complete.`,
    `Concurrency limit: ${input.concurrencyLimit}`,
    `Succeeded: ${input.succeeded}`,
    `Failed: ${input.failed}`,
  ].join('\n');

  const body = results
    .map((item, index) => {
      if (item.ok) {
        return [
          `${index + 1}. [ok] ${item.agentName}`,
          `Task: ${item.task}`,
          `Steps: ${item.steps}`,
          `Summary: ${item.response}`,
        ].join('\n');
      }

      return [
        `${index + 1}. [failed] ${item.agentName}`,
        `Task: ${item.task}`,
        `Error: ${item.error}`,
      ].join('\n');
    })
    .join('\n\n');

  return `${header}\n\n${body}`;
}

function snapshotRuntimeBatch(
  runtimeBatch: RuntimeSubagentBatch,
): PersistedSubagentState {
  const jobs: Record<string, PersistedSubagentJob> = {};
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;

  for (const job of runtimeBatch.jobs.values()) {
    if (job.status === 'completed') succeeded += 1;
    if (job.status === 'failed') failed += 1;
    if (job.status === 'cancelled') cancelled += 1;
    jobs[job.subagentId] = {
      subagentId: job.subagentId,
      batchId: job.batchId,
      agentName: job.agentName,
      task: job.task,
      status: job.status,
      modelId: job.modelId,
      steps: job.steps,
      summary: job.summary,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  const total = runtimeBatch.jobs.size;
  const batchStatus: PersistedSubagentBatch['status'] =
    cancelled === total
      ? 'cancelled'
      : failed > 0
        ? 'failed'
        : succeeded === total
          ? 'completed'
          : 'running';

  return {
    batches: {
      [runtimeBatch.batchId]: {
        batchId: runtimeBatch.batchId,
        status: batchStatus,
        createdAt: runtimeBatch.createdAt,
        updatedAt: new Date().toISOString(),
        concurrencyLimit: runtimeBatch.concurrencyLimit,
        jobs: Array.from(runtimeBatch.jobs.keys()),
        succeeded,
        failed,
        cancelled,
      },
    },
    jobs,
  };
}

async function syncPersistedRuntimeBatchStep(
  sessionId: string,
  runtimeBatch: RuntimeSubagentBatch,
): Promise<PersistedSubagentState> {
  const snapshot = snapshotRuntimeBatch(runtimeBatch);
  const existing = await readPersistedSubagentStateStep(sessionId);
  const next: PersistedSubagentState = {
    batches: {
      ...existing.batches,
      ...snapshot.batches,
    },
    jobs: {
      ...existing.jobs,
      ...snapshot.jobs,
    },
  };
  await writePersistedSubagentStateStep({ sessionId, next });
  return next;
}

function getMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .flatMap((part) =>
      'text' in part && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');
}

function getFinalAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    const text = getMessageText(message).trim();
    if (text.length > 0) {
      return text;
    }
  }

  return '';
}

async function runSubagent(
  context: Parameters<
    NonNullable<ReturnType<typeof defineBuildInTool>['factory']>
  >[1],
  agentName: string,
  task: string,
  options?: {
    subagentId?: string;
    abortSignal?: AbortSignal;
  },
): Promise<{
  subagentId: string;
  agentName: string;
  modelId: string;
  steps: number;
  response: string;
}> {
  const subagentId = options?.subagentId ?? createSubagentId();
  const modelId = getAgentModelId(context.appConfig, agentName);
  const temperature = getAgentTemperature(context.appConfig, agentName);
  const system = await buildSystemPrompt(context.appConfig, {
    agentName,
    useConfiguredAgentPrompt: true,
    delegation: {
      parentAgentName: context.agentName,
    },
    sessionId: context.sessionId,
  });
  const tools = await context.buildNestedTools({
    agentName,
    allowDelegation: false,
  });
  logger.info('agent:init', {
    agentName,
    parentAgentName: context.agentName,
    allowDelegation: false,
    toolNames: Object.keys(tools).sort(),
    toolCount: Object.keys(tools).length,
  });
  const providerOptions = await resolveAgentProviderOptions(
    context.appConfig,
    modelId,
  );
  await writeSubagentEvent({
    subagentId,
    subagentName: agentName,
    event: 'started',
    task,
    modelId,
  });
  const agent = new DurableAgent({
    model: createModelResolver(context.appConfig, modelId),
    system,
    tools,
    temperature,
    providerOptions,
  });
  const writable = context.writable ?? createWritable();

  try {
    const result = await agent.stream({
      messages: [
        {
          role: 'user',
          content: `Caller agent: ${context.agentName}

Delegated task:
${task}

Return a concise result with findings, actions taken, and any blockers or assumptions.`,
        },
      ],
      writable,
      abortSignal: options?.abortSignal,
      sendStart: false,
      sendFinish: false,
      collectUIMessages: false,
      maxSteps: SUB_AGENT_MAX_STEPS,
    });
    const response =
      getFinalAssistantText(result.messages) ||
      result.steps
        .map((step) => step.text.trim())
        .filter((text) => text.length > 0)
        .join('\n\n');

    await writeSubagentEvent({
      subagentId,
      subagentName: agentName,
      event: 'completed',
      task,
      summary: response,
      steps: result.steps.length,
      modelId,
    });

    return {
      subagentId,
      agentName,
      modelId,
      steps: result.steps.length,
      response,
    };
  } catch (error) {
    if (options?.abortSignal?.aborted) {
      const cancelledMessage =
        error instanceof Error ? error.message : 'Cancelled by user';
      await writeSubagentEvent({
        subagentId,
        subagentName: agentName,
        event: 'failed',
        task,
        error: cancelledMessage,
        modelId,
      });
      throw new Error(`Cancelled: ${cancelledMessage}`);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeSubagentEvent({
      subagentId,
      subagentName: agentName,
      event: 'failed',
      task,
      error: errorMessage,
      modelId,
    });
    throw error;
  }
}

export default defineBuildInTool({
  id: 'sub-agent',
  description: `Delegate a focused task to another configured agent in the same workflow.`,
  factory: async (_config, context) => {
    if (!context.allowDelegation) {
      return null;
    }

    const availableAgentNames = getDelegatableAgentNames(
      context.appConfig,
      context.agentName,
    );
    if (availableAgentNames.length === 0) {
      return null;
    }

    return {
      subAgent: tool({
        title: 'Delegate to Sub-Agent',
        description: `Delegate one focused task, or a small batch of independent tasks, to configured sub-agents. Available agent names: ${availableAgentNames.join(', ')}. Include all necessary context in each task because a sub-agent only sees what you pass here. Actions: \`run\` (sync single), \`spawn\` (async batch, returns immediately), \`spawn_async\` (async batch + creates a barrier; pair with the barrier tool to wait across process restarts), \`query\`/\`collect\`/\`cancel\` (inspect a spawned batch).`,
        inputSchema: z.object({
          action: z
            .enum(['run', 'spawn', 'spawn_async', 'query', 'collect', 'cancel'])
            .optional(),
          agentName: z
            .enum(availableAgentNames as [string, ...string[]])
            .optional(),
          task: z.string().min(1).optional(),
          batchId: z.string().min(1).optional(),
          tasks: z
            .array(
              z.object({
                agentName: z.enum(availableAgentNames as [string, ...string[]]),
                task: z.string().min(1),
              }),
            )
            .min(1)
            .max(8)
            .optional(),
          // spawn_async options.
          barrierMode: z
            .enum(['all', 'quorum', 'first_ok', 'first_fail'])
            .default('all')
            .optional()
            .describe(
              'Release condition for the barrier created by spawn_async. ' +
                'Default `all` (wait for every spawned job).',
            ),
          barrierTimeoutMs: z
            .number()
            .int()
            .positive()
            .max(60 * 60 * 1000)
            .optional()
            .describe(
              'Optional hard deadline (ms) on the spawn_async barrier. ' +
                'After this elapses with no satisfying release, the barrier ' +
                'is marked expired and waitForBarrier returns.',
            ),
        }),
        execute: async (input) => {
          const { action, agentName, task, batchId, tasks } = input;
          if (
            action === 'query' ||
            action === 'collect' ||
            action === 'cancel'
          ) {
            if (!batchId) {
              throw new Error('batchId is required for query/collect/cancel.');
            }

            const registryKey = getBatchRegistryKey(context.sessionId, batchId);
            const runtimeBatch = activeSubagentBatches.get(registryKey);
            const persisted = runtimeBatch
              ? await syncPersistedRuntimeBatchStep(
                  context.sessionId,
                  runtimeBatch,
                )
              : await readPersistedSubagentStateStep(context.sessionId);
            const batch = persisted.batches[batchId];
            if (!batch) {
              throw new Error(`Unknown subagent batch: ${batchId}`);
            }

            if (action === 'cancel') {
              if (runtimeBatch) {
                for (const job of runtimeBatch.jobs.values()) {
                  if (job.status === 'queued' || job.status === 'running') {
                    job.status = 'cancelled';
                    job.finishedAt = new Date().toISOString();
                    job.error = 'Cancelled by user';
                    job.controller.abort();
                  }
                }
                const next = await syncPersistedRuntimeBatchStep(
                  context.sessionId,
                  runtimeBatch,
                );
                await writeSubagentBatchEvent({
                  batchId,
                  event: 'cancelled',
                  concurrencyLimit: batch.concurrencyLimit,
                  total: batch.jobs.length,
                  succeeded: next.batches[batchId]?.succeeded,
                  failed: next.batches[batchId]?.failed,
                  cancelled: next.batches[batchId]?.cancelled,
                });
                return {
                  ok: true,
                  mode: 'cancel',
                  batchId,
                  batch: next.batches[batchId],
                };
              }

              return {
                ok: true,
                mode: 'cancel',
                batchId,
                batch,
              };
            }

            const jobs = batch.jobs
              .map((jobId) => persisted.jobs[jobId])
              .filter(Boolean);
            const response = summarizeBatchResults(
              {
                concurrencyLimit: batch.concurrencyLimit,
                succeeded: batch.succeeded,
                failed: batch.failed + batch.cancelled,
              },
              jobs.map((job) =>
                job.status === 'completed'
                  ? {
                      ok: true as const,
                      task: job.task,
                      subagentId: job.subagentId,
                      agentName: job.agentName,
                      modelId: job.modelId ?? 'unknown',
                      steps: job.steps ?? 0,
                      response: job.summary ?? '',
                    }
                  : {
                      ok: false as const,
                      task: job.task,
                      agentName: job.agentName,
                      error: job.error ?? job.status,
                    },
              ),
            );

            return {
              ok: batch.status === 'completed',
              mode: action,
              batchId,
              batch,
              results: jobs,
              response,
            };
          }

          if (action === 'spawn') {
            if (!Array.isArray(tasks) || tasks.length === 0) {
              throw new Error('tasks is required for spawn.');
            }

            const groupedLimits = new Map<string, number>();
            for (const item of tasks) {
              if (!groupedLimits.has(item.agentName)) {
                groupedLimits.set(
                  item.agentName,
                  getSubagentConcurrencyLimit(
                    context.appConfig,
                    item.agentName,
                  ),
                );
              }
            }

            const concurrencyLimit = Math.max(
              1,
              Math.min(...Array.from(groupedLimits.values()), tasks.length),
            );
            const createdAt = new Date().toISOString();
            const createdBatchId = createBatchId();
            const runtimeBatch: RuntimeSubagentBatch = {
              sessionId: context.sessionId,
              batchId: createdBatchId,
              concurrencyLimit,
              createdAt,
              jobs: new Map(),
            };

            for (const item of tasks) {
              const controller = new AbortController();
              const subagentId = createSubagentId();
              const runtimeJob: RuntimeSubagentJob = {
                subagentId,
                batchId: createdBatchId,
                agentName: item.agentName,
                task: item.task,
                status: 'queued',
                controller,
                promise: Promise.resolve(),
              };
              runtimeBatch.jobs.set(subagentId, runtimeJob);
            }

            const registryKey = getBatchRegistryKey(
              context.sessionId,
              createdBatchId,
            );
            activeSubagentBatches.set(registryKey, runtimeBatch);
            await syncPersistedRuntimeBatchStep(
              context.sessionId,
              runtimeBatch,
            );
            const jobList = Array.from(runtimeBatch.jobs.values());
            await writeSubagentBatchEvent({
              batchId: createdBatchId,
              event: 'spawned',
              concurrencyLimit,
              total: jobList.length,
            });
            const scheduled = mapWithConcurrencyLimit(
              jobList,
              concurrencyLimit,
              async (job) => {
                job.status = 'running';
                job.startedAt = new Date().toISOString();
                try {
                  const result = await runSubagent(
                    context,
                    job.agentName,
                    job.task,
                    {
                      subagentId: job.subagentId,
                      abortSignal: job.controller.signal,
                    },
                  );
                  job.status = 'completed';
                  job.modelId = result.modelId;
                  job.steps = result.steps;
                  job.summary = result.response;
                } catch (error) {
                  job.status = job.controller.signal.aborted
                    ? 'cancelled'
                    : 'failed';
                  job.error =
                    error instanceof Error ? error.message : String(error);
                } finally {
                  job.finishedAt = new Date().toISOString();
                }
              },
            ).finally(() => {
              void (async () => {
                const next = await syncPersistedRuntimeBatchStep(
                  context.sessionId,
                  runtimeBatch,
                );
                const batch = next.batches[createdBatchId];
                if (!batch) {
                  return;
                }
                await writeSubagentBatchEvent({
                  batchId: createdBatchId,
                  event:
                    batch.status === 'cancelled' ? 'cancelled' : 'completed',
                  concurrencyLimit,
                  total: jobList.length,
                  succeeded: batch.succeeded,
                  failed: batch.failed,
                  cancelled: batch.cancelled,
                  summary: summarizeBatchResults(
                    {
                      concurrencyLimit,
                      succeeded: batch.succeeded,
                      failed: batch.failed + batch.cancelled,
                    },
                    Array.from(runtimeBatch.jobs.values()).map((job) =>
                      job.status === 'completed'
                        ? {
                            ok: true as const,
                            task: job.task,
                            subagentId: job.subagentId,
                            agentName: job.agentName,
                            modelId: job.modelId ?? 'unknown',
                            steps: job.steps ?? 0,
                            response: job.summary ?? '',
                          }
                        : {
                            ok: false as const,
                            task: job.task,
                            agentName: job.agentName,
                            error: job.error ?? job.status,
                          },
                    ),
                  ),
                });
              })();
            });

            for (const job of jobList) {
              job.promise = scheduled.then(() => undefined);
            }

            return {
              ok: true,
              mode: 'spawn',
              batchId: createdBatchId,
              concurrencyLimit,
              jobIds: jobList.map((job) => job.subagentId),
            };
          }

          if (action === 'spawn_async') {
            // Phase C-mini: spawn N sub-agents AND create a barrier that
            // fires when they finish. Coexists with the classic `spawn`
            // path (above) without touching it — the difference is the
            // extra barrier wiring, which lets a downstream workflow
            // (this run, a different run, or a scheduled task) wait
            // across process restarts via waitForBarrier.
            //
            // The job execution path itself is unchanged; we just hook
            // a release() call into each job's `finally` block.
            if (!Array.isArray(tasks) || tasks.length === 0) {
              throw new Error('tasks is required for spawn_async.');
            }

            const { getBarrierRegistry } = await import(
              '@/lib/workflow/agent/barrier'
            );
            const registry = getBarrierRegistry();

            const barrierMode = input.barrierMode ?? 'all';
            const barrierId = await registry.create({
              sessionId: context.sessionId,
              runId: context.runId,
              expected: tasks.length,
              mode: barrierMode,
              expiresAt: input.barrierTimeoutMs
                ? new Date(Date.now() + input.barrierTimeoutMs)
                : undefined,
            });

            const groupedLimits = new Map<string, number>();
            for (const item of tasks) {
              if (!groupedLimits.has(item.agentName)) {
                groupedLimits.set(
                  item.agentName,
                  getSubagentConcurrencyLimit(
                    context.appConfig,
                    item.agentName,
                  ),
                );
              }
            }

            const concurrencyLimit = Math.max(
              1,
              Math.min(...Array.from(groupedLimits.values()), tasks.length),
            );
            const createdAt = new Date().toISOString();
            const createdBatchId = createBatchId();
            const runtimeBatch: RuntimeSubagentBatch = {
              sessionId: context.sessionId,
              batchId: createdBatchId,
              concurrencyLimit,
              createdAt,
              jobs: new Map(),
            };

            for (const item of tasks) {
              const controller = new AbortController();
              const subagentId = createSubagentId();
              const runtimeJob: RuntimeSubagentJob = {
                subagentId,
                batchId: createdBatchId,
                agentName: item.agentName,
                task: item.task,
                status: 'queued',
                controller,
                promise: Promise.resolve(),
              };
              runtimeBatch.jobs.set(subagentId, runtimeJob);
            }

            const registryKey = getBatchRegistryKey(
              context.sessionId,
              createdBatchId,
            );
            activeSubagentBatches.set(registryKey, runtimeBatch);
            await syncPersistedRuntimeBatchStep(
              context.sessionId,
              runtimeBatch,
            );
            const jobList = Array.from(runtimeBatch.jobs.values());
            await writeSubagentBatchEvent({
              batchId: createdBatchId,
              event: 'spawned',
              concurrencyLimit,
              total: jobList.length,
            });

            const scheduled = mapWithConcurrencyLimit(
              jobList,
              concurrencyLimit,
              async (job) => {
                job.status = 'running';
                job.startedAt = new Date().toISOString();
                try {
                  const result = await runSubagent(
                    context,
                    job.agentName,
                    job.task,
                    {
                      subagentId: job.subagentId,
                      abortSignal: job.controller.signal,
                    },
                  );
                  job.status = 'completed';
                  job.modelId = result.modelId;
                  job.steps = result.steps;
                  job.summary = result.response;
                } catch (error) {
                  job.status = job.controller.signal.aborted
                    ? 'cancelled'
                    : 'failed';
                  job.error =
                    error instanceof Error ? error.message : String(error);
                } finally {
                  job.finishedAt = new Date().toISOString();
                  // Release this job's slot in the barrier. Best-effort:
                  // a failed release (e.g. barrier already expired) is
                  // logged by the registry and does not affect the job.
                  try {
                    await registry.release({
                      barrierId,
                      participantId: job.subagentId,
                      ok: job.status === 'completed',
                      payload: {
                        subagentId: job.subagentId,
                        agentName: job.agentName,
                        task: job.task,
                        status: job.status,
                        modelId: job.modelId,
                        steps: job.steps,
                        summary: job.summary,
                        error: job.error,
                      },
                    });
                  } catch (releaseError) {
                    logger.warn('spawn_async: barrier release failed', {
                      barrierId,
                      subagentId: job.subagentId,
                      error:
                        releaseError instanceof Error
                          ? releaseError.message
                          : String(releaseError),
                    });
                  }
                }
              },
            ).finally(() => {
              void (async () => {
                const next = await syncPersistedRuntimeBatchStep(
                  context.sessionId,
                  runtimeBatch,
                );
                const batch = next.batches[createdBatchId];
                if (!batch) {
                  return;
                }
                await writeSubagentBatchEvent({
                  batchId: createdBatchId,
                  event:
                    batch.status === 'cancelled' ? 'cancelled' : 'completed',
                  concurrencyLimit,
                  total: jobList.length,
                  succeeded: batch.succeeded,
                  failed: batch.failed,
                  cancelled: batch.cancelled,
                  summary: summarizeBatchResults(
                    {
                      concurrencyLimit,
                      succeeded: batch.succeeded,
                      failed: batch.failed + batch.cancelled,
                    },
                    Array.from(runtimeBatch.jobs.values()).map((job) =>
                      job.status === 'completed'
                        ? {
                            ok: true as const,
                            task: job.task,
                            subagentId: job.subagentId,
                            agentName: job.agentName,
                            modelId: job.modelId ?? 'unknown',
                            steps: job.steps ?? 0,
                            response: job.summary ?? '',
                          }
                        : {
                            ok: false as const,
                            task: job.task,
                            agentName: job.agentName,
                            error: job.error ?? job.status,
                          },
                    ),
                  ),
                });
              })();
            });

            for (const job of jobList) {
              job.promise = scheduled.then(() => undefined);
            }

            return {
              ok: true,
              mode: 'spawn_async',
              batchId: createdBatchId,
              barrierId,
              concurrencyLimit,
              jobIds: jobList.map((job) => job.subagentId),
              hint: `Use the barrier tool with action=wait, barrierId=${barrierId} to block until completion. Use action=status to peek.`,
            };
          }

          if (Array.isArray(tasks) && tasks.length > 0) {
            const groupedLimits = new Map<string, number>();
            for (const item of tasks) {
              if (!groupedLimits.has(item.agentName)) {
                groupedLimits.set(
                  item.agentName,
                  getSubagentConcurrencyLimit(
                    context.appConfig,
                    item.agentName,
                  ),
                );
              }
            }

            const concurrencyLimit = Math.max(
              1,
              Math.min(...Array.from(groupedLimits.values()), tasks.length),
            );

            const settled = await mapWithConcurrencyLimit(
              tasks,
              concurrencyLimit,
              async (item) => {
                try {
                  const result = await runSubagent(
                    context,
                    item.agentName,
                    item.task,
                  );
                  return {
                    ok: true as const,
                    task: item.task,
                    ...result,
                  };
                } catch (error) {
                  return {
                    ok: false as const,
                    task: item.task,
                    agentName: item.agentName,
                    error:
                      error instanceof Error ? error.message : String(error),
                  };
                }
              },
            );

            const succeeded = settled.filter((item) => item.ok).length;
            const failed = settled.length - succeeded;
            return {
              ok: failed === 0,
              mode: 'batch',
              concurrencyLimit,
              succeeded,
              failed,
              response: summarizeBatchResults(
                {
                  concurrencyLimit,
                  succeeded,
                  failed,
                },
                settled,
              ),
              results: settled,
            };
          }

          if (!agentName || !task) {
            throw new Error(
              'Provide either { agentName, task } or { tasks: [...] }.',
            );
          }

          const result = await runSubagent(context, agentName, task);
          return {
            ok: true,
            agentName,
            modelId: result.modelId,
            steps: result.steps,
            response: result.response,
          };
        },
      }),
    };
  },
});
