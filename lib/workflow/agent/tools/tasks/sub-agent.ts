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

// ── Runtime (in-process hot cache) ────────────────────────────────
//
// Phase C-full: persistence moved to agentSubagentBatches/agentSubagentJobs
// tables. The in-process Map only retains AbortControllers + Promise
// handles, which can't be persisted. If the workflow process restarts
// mid-batch, the jobs' abort controllers are lost (already-running
// sub-agent.stream calls will continue until they finish or the workflow
// run itself cancels), but the DB rows still reflect each job's last
// persisted status. The cancel() action falls back to writing
// status='cancelled' directly to the DB when no controller is present.

interface RuntimeJob {
  subagentId: string;
  controller: AbortController;
  promise: Promise<void>;
}
interface RuntimeBatch {
  sessionId: string;
  batchId: string;
  jobs: Map<string, RuntimeJob>;
}

const activeSubagentBatches = new Map<string, RuntimeBatch>();

function createSubagentId(): string {
  return `wf-subagent-${Math.random().toString(36).slice(2, 10)}`;
}
function createBatchId(): string {
  return `wf-subagent-batch-${Math.random().toString(36).slice(2, 10)}`;
}
function getBatchRegistryKey(sessionId: string, batchId: string): string {
  return `${sessionId}:${batchId}`;
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
  if (items.length === 0) return [];
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

// ── DB persistence (use-step wrappers) ────────────────────────────

async function persistBatchCreateStep(input: {
  sessionId: string;
  runId: string;
  batchId: string;
  concurrencyLimit: number;
  barrierId?: string;
  jobs: Array<{ subagentId: string; agentName: string; task: string }>;
}): Promise<void> {
  'use step';
  const { createBatch } = await import('@/lib/core/db/agent-subagents');
  await createBatch({
    batchId: input.batchId,
    sessionId: input.sessionId,
    runId: input.runId,
    barrierId: input.barrierId,
    concurrencyLimit: input.concurrencyLimit,
    jobs: input.jobs,
  });
}

async function persistJobStatusStep(input: {
  subagentId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  modelId?: string;
  steps?: number;
  summary?: string;
  error?: string;
}): Promise<void> {
  'use step';
  const { updateJobStatus } = await import('@/lib/core/db/agent-subagents');
  await updateJobStatus(input);
}

async function loadBatchStep(
  sessionId: string,
  batchId: string,
): Promise<{
  batch: {
    batchId: string;
    status: string;
    concurrencyLimit: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    barrierId: string | null;
  } | null;
  jobs: Array<{
    subagentId: string;
    agentName: string;
    task: string;
    status: string;
    modelId: string | null;
    steps: number | null;
    summary: string | null;
    error: string | null;
  }>;
}> {
  'use step';
  const { getBatchWithJobs, migrateBatchFromLegacyMetadata } = await import(
    '@/lib/core/db/agent-subagents'
  );
  const { getSession } = await import('@/lib/core/db/chat');

  let result = await getBatchWithJobs(batchId);

  // Lazy legacy migration: if the batch is missing from the new tables
  // but exists in sessions.metadata.workflowSubagents (the pre-C-full
  // persistence path), backfill it transparently.
  if (!result) {
    const session = await getSession(sessionId);
    const meta = (session?.metadata ?? {}) as Record<string, unknown>;
    const legacy = (meta.workflowSubagents ?? {}) as {
      batches?: Record<string, unknown>;
      jobs?: Record<string, unknown>;
    };
    if (legacy.batches && legacy.batches[batchId]) {
      result = await migrateBatchFromLegacyMetadata({
        sessionId,
        batchId,
        legacy: {
          batches: legacy.batches,
          jobs: legacy.jobs ?? {},
        },
      });
    }
  }

  if (!result) {
    return { batch: null, jobs: [] };
  }
  return {
    batch: {
      batchId: result.batch.batchId,
      status: result.batch.status,
      concurrencyLimit: result.batch.concurrencyLimit,
      succeeded: result.batch.succeeded,
      failed: result.batch.failed,
      cancelled: result.batch.cancelled,
      barrierId: result.batch.barrierId,
    },
    jobs: result.jobs.map((j) => ({
      subagentId: j.subagentId,
      agentName: j.agentName,
      task: j.task,
      status: j.status,
      modelId: j.modelId,
      steps: j.steps,
      summary: j.summary,
      error: j.error,
    })),
  };
}

async function cancelBatchJobsStep(
  batchId: string,
  reason: string,
): Promise<void> {
  'use step';
  const { cancelBatchJobs } = await import('@/lib/core/db/agent-subagents');
  await cancelBatchJobs(batchId, reason);
}

// ── Helpers ───────────────────────────────────────────────────────

function getMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .flatMap((part) =>
      'text' in part && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');
}

function getFinalAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const text = getMessageText(m).trim();
    if (text.length > 0) return text;
  }
  return '';
}

function summarizeBatchResults(
  input: { concurrencyLimit: number; succeeded: number; failed: number },
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
    | { ok: false; task: string; agentName: string; error: string }
  >,
): string {
  const header = [
    'Batch sub-agent run complete.',
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

// ── Sub-agent runner ──────────────────────────────────────────────

async function runSubagent(
  context: Parameters<
    NonNullable<ReturnType<typeof defineBuildInTool>['factory']>
  >[1],
  agentName: string,
  task: string,
  options?: { subagentId?: string; abortSignal?: AbortSignal },
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
    delegation: { parentAgentName: context.agentName },
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
        .map((s) => s.text.trim())
        .filter((t) => t.length > 0)
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
      const msg = error instanceof Error ? error.message : 'Cancelled by user';
      await writeSubagentEvent({
        subagentId,
        subagentName: agentName,
        event: 'failed',
        task,
        error: msg,
        modelId,
      });
      throw new Error(`Cancelled: ${msg}`);
    }
    const msg = error instanceof Error ? error.message : String(error);
    await writeSubagentEvent({
      subagentId,
      subagentName: agentName,
      event: 'failed',
      task,
      error: msg,
      modelId,
    });
    throw error;
  }
}

// Shared worker body for spawn + spawn_async. Updates both the runtime
// cache (for abort) and the DB (for durability). The optional
// onTerminal callback lets spawn_async hook in a barrier release.
async function executeSubagentJob(
  context: Parameters<
    NonNullable<ReturnType<typeof defineBuildInTool>['factory']>
  >[1],
  job: { subagentId: string; agentName: string; task: string },
  controller: AbortController,
  onTerminal?: (result: {
    status: 'completed' | 'failed' | 'cancelled';
    modelId?: string;
    steps?: number;
    summary?: string;
    error?: string;
  }) => Promise<void>,
): Promise<void> {
  await persistJobStatusStep({
    subagentId: job.subagentId,
    status: 'running',
  });
  try {
    const r = await runSubagent(context, job.agentName, job.task, {
      subagentId: job.subagentId,
      abortSignal: controller.signal,
    });
    await persistJobStatusStep({
      subagentId: job.subagentId,
      status: 'completed',
      modelId: r.modelId,
      steps: r.steps,
      summary: r.response,
    });
    await onTerminal?.({
      status: 'completed',
      modelId: r.modelId,
      steps: r.steps,
      summary: r.response,
    });
  } catch (error) {
    const status: 'failed' | 'cancelled' = controller.signal.aborted
      ? 'cancelled'
      : 'failed';
    const errorMsg = error instanceof Error ? error.message : String(error);
    await persistJobStatusStep({
      subagentId: job.subagentId,
      status,
      error: errorMsg,
    });
    await onTerminal?.({ status, error: errorMsg });
  }
}

// ── Tool registration ─────────────────────────────────────────────

export default defineBuildInTool({
  id: 'sub-agent',
  description: `Delegate a focused task to another configured agent in the same workflow.`,
  factory: async (_config, context) => {
    if (!context.allowDelegation) return null;
    const availableAgentNames = getDelegatableAgentNames(
      context.appConfig,
      context.agentName,
    );
    if (availableAgentNames.length === 0) return null;

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
          barrierMode: z
            .enum(['all', 'quorum', 'first_ok', 'first_fail'])
            .default('all')
            .optional()
            .describe(
              'Release condition for the barrier created by spawn_async. Default `all`.',
            ),
          barrierTimeoutMs: z
            .number()
            .int()
            .positive()
            .max(60 * 60 * 1000)
            .optional()
            .describe(
              'Optional hard deadline (ms) on the spawn_async barrier.',
            ),
        }),
        execute: async (input) => {
          const { action, agentName, task, batchId, tasks } = input;

          // ── query / collect / cancel ────────────────────────────
          if (
            action === 'query' ||
            action === 'collect' ||
            action === 'cancel'
          ) {
            if (!batchId) {
              throw new Error('batchId is required for query/collect/cancel.');
            }

            if (action === 'cancel') {
              const registryKey = getBatchRegistryKey(
                context.sessionId,
                batchId,
              );
              const runtimeBatch = activeSubagentBatches.get(registryKey);
              if (runtimeBatch) {
                // Abort every in-flight job via its controller.
                for (const job of runtimeBatch.jobs.values()) {
                  job.controller.abort();
                }
              }
              // Always write cancelled to DB (covers jobs whose
              // controllers were lost across a process restart).
              await cancelBatchJobsStep(batchId, 'Cancelled by user');
            }

            const loaded = await loadBatchStep(context.sessionId, batchId);
            if (!loaded.batch) {
              throw new Error(`Unknown subagent batch: ${batchId}`);
            }

            // Emit a stream event for cancel so the UI/CLI sees the
            // cancellation even if no terminal event arrives from an
            // aborted job. Matches the legacy payload shape so the CLI
            // adapter (subpackage/cli/.../web-stream.ts) is unchanged.
            if (action === 'cancel') {
              await writeSubagentBatchEvent({
                batchId,
                event: 'cancelled',
                concurrencyLimit: loaded.batch.concurrencyLimit,
                total: loaded.jobs.length,
                succeeded: loaded.batch.succeeded,
                failed: loaded.batch.failed,
                cancelled: loaded.batch.cancelled,
              });
              return {
                ok: true,
                mode: 'cancel',
                batchId,
                batch: loaded.batch,
              };
            }

            // query / collect: surface the human-readable summary.
            const response = summarizeBatchResults(
              {
                concurrencyLimit: loaded.batch.concurrencyLimit,
                succeeded: loaded.batch.succeeded,
                failed: loaded.batch.failed + loaded.batch.cancelled,
              },
              loaded.jobs.map((j) =>
                j.status === 'completed'
                  ? {
                      ok: true as const,
                      task: j.task,
                      subagentId: j.subagentId,
                      agentName: j.agentName,
                      modelId: j.modelId ?? 'unknown',
                      steps: j.steps ?? 0,
                      response: j.summary ?? '',
                    }
                  : {
                      ok: false as const,
                      task: j.task,
                      agentName: j.agentName,
                      error: j.error ?? j.status,
                    },
              ),
            );
            return {
              ok: loaded.batch.status === 'completed',
              mode: action,
              batchId,
              batch: loaded.batch,
              results: loaded.jobs,
              response,
            };
          }

          // ── spawn + spawn_async (shared dispatch) ───────────────
          if (action === 'spawn' || action === 'spawn_async') {
            if (!Array.isArray(tasks) || tasks.length === 0) {
              throw new Error(`tasks is required for ${action}.`);
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

            // spawn_async: create the barrier first so the persisted
            // batch row can carry the barrierId (lets a UI display the
            // link and lets aggregate/cancel find it).
            let barrierId: string | undefined;
            if (action === 'spawn_async') {
              const { getBarrierRegistry } = await import(
                '@/lib/workflow/agent/barrier'
              );
              const registry = getBarrierRegistry();
              barrierId = await registry.create({
                sessionId: context.sessionId,
                runId: context.runId,
                expected: tasks.length,
                mode: input.barrierMode ?? 'all',
                expiresAt: input.barrierTimeoutMs
                  ? new Date(Date.now() + input.barrierTimeoutMs)
                  : undefined,
              });
            }

            const createdBatchId = createBatchId();
            const jobSpecs = tasks.map((t) => ({
              subagentId: createSubagentId(),
              agentName: t.agentName,
              task: t.task,
            }));

            // Persist the batch + queued jobs to the DB. abort
            // controllers live in the runtime cache below.
            await persistBatchCreateStep({
              sessionId: context.sessionId,
              runId: context.runId,
              batchId: createdBatchId,
              concurrencyLimit,
              barrierId,
              jobs: jobSpecs,
            });

            const runtimeBatch: RuntimeBatch = {
              sessionId: context.sessionId,
              batchId: createdBatchId,
              jobs: new Map(
                jobSpecs.map((j) => [
                  j.subagentId,
                  {
                    subagentId: j.subagentId,
                    controller: new AbortController(),
                    promise: Promise.resolve(),
                  },
                ]),
              ),
            };
            activeSubagentBatches.set(
              getBatchRegistryKey(context.sessionId, createdBatchId),
              runtimeBatch,
            );

            await writeSubagentBatchEvent({
              batchId: createdBatchId,
              event: 'spawned',
              concurrencyLimit,
              total: jobSpecs.length,
            });

            // spawn_async: each job's terminal hook calls
            // registry.release() with that job's subagentId so the
            // barrier sees one distinct participant per job. Best-
            // effort — a failed release (barrier already expired) is
            // logged and does not affect the job.
            const scheduled = mapWithConcurrencyLimit(
              jobSpecs,
              concurrencyLimit,
              async (spec) => {
                const runtimeEntry = runtimeBatch.jobs.get(spec.subagentId);
                const controller =
                  runtimeEntry?.controller ?? new AbortController();
                const onTerminal = barrierId
                  ? async (r: {
                      status: 'completed' | 'failed' | 'cancelled';
                      modelId?: string;
                      steps?: number;
                      summary?: string;
                      error?: string;
                    }) => {
                      try {
                        const { getBarrierRegistry } = await import(
                          '@/lib/workflow/agent/barrier'
                        );
                        await getBarrierRegistry().release({
                          barrierId: barrierId,
                          participantId: spec.subagentId,
                          ok: r.status === 'completed',
                          payload: {
                            subagentId: spec.subagentId,
                            agentName: spec.agentName,
                            task: spec.task,
                            ...r,
                          },
                        });
                      } catch (releaseError) {
                        logger.warn('spawn_async: barrier release failed', {
                          barrierId,
                          subagentId: spec.subagentId,
                          error:
                            releaseError instanceof Error
                              ? releaseError.message
                              : String(releaseError),
                        });
                      }
                    }
                  : undefined;
                await executeSubagentJob(context, spec, controller, onTerminal);
              },
            ).finally(() => {
              void (async () => {
                // After all jobs settle, emit a terminal batch event
                // matching the legacy payload shape. Read the persisted
                // state so the counters reflect every job.
                const loaded = await loadBatchStep(
                  context.sessionId,
                  createdBatchId,
                );
                if (!loaded.batch) return;
                await writeSubagentBatchEvent({
                  batchId: createdBatchId,
                  event:
                    loaded.batch.status === 'cancelled'
                      ? 'cancelled'
                      : 'completed',
                  concurrencyLimit,
                  total: loaded.jobs.length,
                  succeeded: loaded.batch.succeeded,
                  failed: loaded.batch.failed,
                  cancelled: loaded.batch.cancelled,
                  summary: summarizeBatchResults(
                    {
                      concurrencyLimit,
                      succeeded: loaded.batch.succeeded,
                      failed: loaded.batch.failed + loaded.batch.cancelled,
                    },
                    loaded.jobs.map((j) =>
                      j.status === 'completed'
                        ? {
                            ok: true as const,
                            task: j.task,
                            subagentId: j.subagentId,
                            agentName: j.agentName,
                            modelId: j.modelId ?? 'unknown',
                            steps: j.steps ?? 0,
                            response: j.summary ?? '',
                          }
                        : {
                            ok: false as const,
                            task: j.task,
                            agentName: j.agentName,
                            error: j.error ?? j.status,
                          },
                    ),
                  ),
                });
              })();
            });

            // Track each promise so cancel() can await or abort.
            for (const spec of jobSpecs) {
              const entry = runtimeBatch.jobs.get(spec.subagentId);
              if (entry) entry.promise = scheduled.then(() => undefined);
            }

            return {
              ok: true,
              mode: action,
              batchId: createdBatchId,
              barrierId,
              concurrencyLimit,
              jobIds: jobSpecs.map((j) => j.subagentId),
              hint:
                action === 'spawn_async' && barrierId
                  ? `Use the barrier tool with action=wait, barrierId=${barrierId} to block until completion. Use action=status to peek.`
                  : undefined,
            };
          }

          // ── sync batch (no action OR action=run with tasks[]) ──
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
                  const r = await runSubagent(
                    context,
                    item.agentName,
                    item.task,
                  );
                  return { ok: true as const, task: item.task, ...r };
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
            const succeeded = settled.filter((x) => x.ok).length;
            const failed = settled.length - succeeded;
            return {
              ok: failed === 0,
              mode: 'batch',
              concurrencyLimit,
              succeeded,
              failed,
              response: summarizeBatchResults(
                { concurrencyLimit, succeeded, failed },
                settled,
              ),
              results: settled,
            };
          }

          // ── sync single (action=run with agentName+task) ────────
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
