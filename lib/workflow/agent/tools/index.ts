import { parseProviderScopedModelId } from '@/lib/ai';
import type { AppConfig } from '@/types/config';
import type { ToolCatalogResponse } from '@/types/config/tools';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { createLogger } from '@/lib/utils/logger';
import { MAIN_AGENT_NAME, getMainAgentModelId } from '../utils/agent-config';
import type { BuildAgentToolsOptions, BuildInToolDefinition } from './define';
import { getMCPTools } from './mcp';
import { getTrapToolKeys, suggestClosestName } from './tool-name-guard';
export {
  defineBuildInTool,
  type BuildAgentToolsOptions,
  type BuildInToolDefinition,
} from './define';

import agentdNodesTool from './agentd/nodes';
import sandboxTool from './execute/sanbox';
import memoryTool from './memories/local';
import localSkillTool from './skills/local';
import scheduleTool from './tasks/schedule';
import subAgentTool from './tasks/sub-agent';
import taskSummaryTool from './tasks/summary';

const BUILT_IN_TOOLS: BuildInToolDefinition[] = [
  sandboxTool,
  memoryTool,
  localSkillTool,
  scheduleTool,
  taskSummaryTool,
  subAgentTool,
  agentdNodesTool,
];

export function getBuildInToolCatalog(config: AppConfig): ToolCatalogResponse {
  return {
    tools: BUILT_IN_TOOLS.map((definition) => definition.toCatalogItem(config)),
  };
}

export async function buildAgentTools(
  config: AppConfig,
  sessionId: string,
  options: BuildAgentToolsOptions = {},
): Promise<ToolSet> {
  const tools: ToolSet = {};
  const runId = options.runId ?? sessionId;
  const agentName = options.agentName ?? MAIN_AGENT_NAME;
  const allowDelegation = options.allowDelegation ?? true;
  const writable = options.writable;
  const buildNestedTools = (nestedOptions: BuildAgentToolsOptions = {}) =>
    buildAgentTools(config, sessionId, {
      runId,
      agentName,
      allowDelegation,
      writable,
      ...nestedOptions,
    });

  for (const definition of BUILT_IN_TOOLS) {
    const registeredTools = await definition.register(config, {
      sessionId,
      runId,
      appConfig: config,
      agentName,
      allowDelegation,
      writable,
      buildNestedTools,
    });

    if (!registeredTools) {
      continue;
    }

    Object.assign(tools, registeredTools);
  }

  const mcpTools = await getMCPTools(
    config.mcp,
    'MCP',
    {
      sessionId,
      agentName,
    },
    config,
  );
  const mergedTools: ToolSet = {
    ...tools,
    ...mcpTools,
  };

  // Defensive trap tools for OpenAI-compatible providers that occasionally
  // emit tool calls with an empty or aliased name. Without these, a single
  // malformed call crashes the entire workflow run with "Tool \"\" not found".
  // The trap tools return a model-facing error listing valid names so the
  // agent can recover and retry with a correct name in the next step.
  const trapTools = buildTrapTools(config, Object.keys(mergedTools));
  return {
    ...mergedTools,
    ...trapTools,
  };
}

/**
 * Resolve the provider format for the main agent's configured model.
 *
 * Mirrors the resolution logic in `lib/ai/index.ts` but returns only the
 * format string, defaulting to `undefined` when resolution fails. We avoid
 * throwing here because trap registration is a best-effort defense.
 */
function resolveMainProviderFormat(config: AppConfig): string | undefined {
  try {
    const modelId = getMainAgentModelId(config);
    const parsed = parseProviderScopedModelId(modelId);
    const providers = config.models?.providers ?? {};
    const providerKeys = Object.keys(providers);
    const providerName = parsed.providerName ?? providerKeys[0];
    return providers[providerName]?.format;
  } catch {
    return undefined;
  }
}

/**
 * Build the set of trap tools for the current provider.
 *
 * Each trap tool has an empty input schema (accepts anything) and no
 * description, so well-behaved models have no incentive to call them. When
 * invoked, they return a structured error that lists the real tool names and
 * suggests the closest match by edit distance, allowing the model to retry.
 */
function buildTrapTools(config: AppConfig, knownNames: string[]): ToolSet {
  const format = resolveMainProviderFormat(config);
  const trapKeys = getTrapToolKeys(format, knownNames);
  if (trapKeys.length === 0) {
    return {};
  }

  const logger = createLogger('workflow.agent.tools.trap');
  const known = new Set(knownNames);
  const traps: ToolSet = {};

  for (const key of trapKeys) {
    // Each trap closes over its own `key` so the error message can name it.
    const trapKey = key;
    traps[trapKey] = tool({
      description:
        'Internal fallback invoked when the model emits a tool call with an empty name. Do not call this tool directly.',
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (input, options) => {
        const toolCallId = options?.toolCallId ?? '<unknown>';
        logger.warn('trap:invoked', {
          trapKey: trapKey.length === 0 ? '<empty>' : trapKey,
          toolCallId,
          inputKeys: Object.keys(input ?? {}),
        });
        const suggestion = suggestClosestName(trapKey, known);
        return {
          ok: false,
          error:
            trapKey.length === 0
              ? 'Tool name was empty. The model emitted a tool_call without a function name.'
              : `Tool name "${trapKey}" is not a valid tool.`,
          suggestion,
          availableTools: knownNames.filter((n) => n.length > 0),
          hint: 'Please retry the action using one of the available tool names listed in "availableTools".',
        };
      },
    });
  }

  return traps;
}
