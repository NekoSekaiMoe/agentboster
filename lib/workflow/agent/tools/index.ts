import type { AppConfig } from '@/types/config';
import type { ToolCatalogResponse } from '@/types/config/tools';
import type { ToolSet } from 'ai';
import { MAIN_AGENT_NAME } from '../utils/agent-config';
import type { BuildAgentToolsOptions, BuildInToolDefinition } from './define';
import { getMCPTools } from './mcp';
export {
  defineBuildInTool,
  type BuildAgentToolsOptions,
  type BuildInToolDefinition,
} from './define';

import sandboxTool from './execute/sanbox';
import memoryTool from './memories/local';
import localSkillTool from './skills/local';
import scheduleTool from './tasks/schedule';
import subAgentTool from './tasks/sub-agent';

const BUILT_IN_TOOLS: BuildInToolDefinition[] = [
  sandboxTool,
  memoryTool,
  localSkillTool,
  scheduleTool,
  subAgentTool,
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
  return {
    ...tools,
    ...mcpTools,
  };
}
