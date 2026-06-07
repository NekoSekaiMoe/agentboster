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
import { createWritable } from '../../sender/writers';
import { defineBuildInTool } from '../define';

const SUB_AGENT_MAX_STEPS = 12;
const logger = createLogger('workflow.agent.tools.sub-agent');

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
        description: `Delegate a task to one of the configured sub-agents. Available agent names: ${availableAgentNames.join(', ')}. Include all necessary context in task because the sub-agent only sees what you pass here.`,
        inputSchema: z.object({
          agentName: z.enum(availableAgentNames as [string, ...string[]]),
          task: z.string().min(1),
        }),
        execute: async ({ agentName, task }) => {
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
          const agent = new DurableAgent({
            model: createModelResolver(context.appConfig, modelId),
            system,
            tools,
            temperature,
            providerOptions,
          });
          const writable = context.writable ?? createWritable();

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

          return {
            ok: true,
            agentName,
            modelId,
            steps: result.steps.length,
            response,
          };
        },
      }),
    };
  },
});
