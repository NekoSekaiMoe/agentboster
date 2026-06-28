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
import { createWritable, writeSubagentEvent } from '../../sender/writers';
import { defineBuildInTool } from '../define';

const SUB_AGENT_MAX_STEPS = 12;
const DEFAULT_MAX_PARALLEL_SUBAGENTS = 3;
const logger = createLogger('workflow.agent.tools.sub-agent');

function createSubagentId(): string {
  return `wf-subagent-${Math.random().toString(36).slice(2, 10)}`;
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
  return results
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
): Promise<{
  subagentId: string;
  agentName: string;
  modelId: string;
  steps: number;
  response: string;
}> {
  const subagentId = createSubagentId();
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
        description: `Delegate one focused task, or a small batch of independent tasks, to configured sub-agents. Available agent names: ${availableAgentNames.join(', ')}. Include all necessary context in each task because a sub-agent only sees what you pass here.`,
        inputSchema: z.object({
          agentName: z
            .enum(availableAgentNames as [string, ...string[]])
            .optional(),
          task: z.string().min(1).optional(),
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
        }),
        execute: async ({ agentName, task, tasks }) => {
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
              response: summarizeBatchResults(settled),
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
