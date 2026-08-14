import { getBuiltinMcpServers } from '@/lib/mcp/builtin';
import { createLogger } from '@/lib/utils/logger';
import type { MCPRemoteServersConfig } from '@/types/config/mcp';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { type ToolSet, dynamicTool, jsonSchema } from 'ai';
import { withToolExecutionLogger } from './define';

type MCPToolDescriptor = {
  key: string;
  serverName: string;
  toolName: string;
  builtin?: boolean;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
};

const logger = createLogger('workflow.agent.tools.mcp');

function normalizePart(value: string): string {
  return value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMCPToolKey(
  baseName: string,
  serverName: string,
  toolName: string,
): string {
  return `${normalizePart(baseName)}_${normalizePart(serverName)}_${normalizePart(toolName)}`;
}

function createMCPInputSchema(inputSchema: Record<string, unknown>) {
  return jsonSchema(inputSchema, {
    validate: async (value) => ({
      success: true,
      value:
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
    }),
  });
}

async function listMCPToolDescriptorsForServer(
  serverName: string,
  serverConfig: MCPRemoteServersConfig[string],
  baseName: string,
): Promise<MCPToolDescriptor[]> {
  const { createMCPClient } = await import('@ai-sdk/mcp');
  const client = await createMCPClient({
    transport: {
      type: serverConfig.type,
      url: serverConfig.url,
      headers: serverConfig.headers,
    },
  });

  try {
    const definitions = await client.listTools();
    const descriptors: MCPToolDescriptor[] = [];

    for (const tool of definitions.tools) {
      descriptors.push({
        key: buildMCPToolKey(baseName, serverName, tool.name),
        serverName,
        toolName: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    return descriptors;
  } finally {
    await client.close();
  }
}

export async function listMCPToolDescriptors(
  config: MCPRemoteServersConfig,
  baseName: string,
): Promise<MCPToolDescriptor[]> {
  'use step';

  const serverEntries = Object.entries(config);
  const settledResults = await Promise.allSettled(
    serverEntries.map(([serverName, serverConfig]) =>
      listMCPToolDescriptorsForServer(serverName, serverConfig, baseName),
    ),
  );
  const descriptors: MCPToolDescriptor[] = [];

  for (const [index, result] of settledResults.entries()) {
    if (result.status === 'fulfilled') {
      descriptors.push(...result.value);
      continue;
    }

    const serverName = serverEntries[index]?.[0] ?? `server-${index}`;
    logger.warn('server:register:failed', {
      serverName,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  }

  return descriptors;
}

export async function listBuiltinMCPToolDescriptors(
  _baseName: string,
): Promise<MCPToolDescriptor[]> {
  'use step';

  const { createMCPClient } = await import('@ai-sdk/mcp');
  const descriptors: MCPToolDescriptor[] = [];
  const serverEntries = Object.entries(getBuiltinMcpServers());

  for (const [serverName, serverConfig] of serverEntries) {
    const client = await createMCPClient({
      transport: serverConfig.transport,
      clientName: 'agentboster-builtin-mcp-client',
    });

    try {
      const definitions = await client.listTools();

      for (const tool of definitions.tools) {
        descriptors.push({
          key: tool.name,
          serverName,
          toolName: tool.name,
          builtin: true,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    } finally {
      await client.close();
    }
  }

  return descriptors;
}

export async function executeMCPTool(input: {
  config: MCPRemoteServersConfig;
  serverName: string;
  toolName: string;
  toolKey?: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  'use step';

  const serverConfig = input.config[input.serverName];
  if (!serverConfig) {
    throw new Error(`MCP server "${input.serverName}" not found`);
  }

  const { createMCPClient } = await import('@ai-sdk/mcp');
  const client = await createMCPClient({
    transport: {
      type: serverConfig.type,
      url: serverConfig.url,
      headers: serverConfig.headers,
    },
  });

  try {
    const definitions = await client.listTools();
    const tools = client.toolsFromDefinitions(definitions);
    const tool = tools[input.toolName];

    if (!tool?.execute) {
      throw new Error(
        `MCP tool "${input.toolName}" not found on server "${input.serverName}"`,
      );
    }

    const result = await tool.execute(input.args, {
      toolCallId: `${input.serverName}:${input.toolName}`,
      messages: [],
    });

    return result;
  } finally {
    await client.close();
  }
}

async function executeBuiltinMCPTool(input: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  context?: {
    sessionId?: string;
    agentName?: string;
  };
}): Promise<unknown> {
  'use step';

  const serverConfig = getBuiltinMcpServers(input.context)[
    input.serverName as keyof ReturnType<typeof getBuiltinMcpServers>
  ];

  if (!serverConfig) {
    throw new Error(`Builtin MCP server "${input.serverName}" not found`);
  }

  const { createMCPClient } = await import('@ai-sdk/mcp');
  const client = await createMCPClient({
    transport: serverConfig.transport,
    clientName: 'agentboster-builtin-mcp-client',
  });

  try {
    const definitions = await client.listTools();
    const tools = client.toolsFromDefinitions(definitions);
    const tool = tools[input.toolName];

    if (!tool?.execute) {
      throw new Error(
        `Builtin MCP tool "${input.toolName}" not found on server "${input.serverName}"`,
      );
    }

    return await tool.execute(input.args, {
      toolCallId: `builtin:${input.serverName}:${input.toolName}`,
      messages: [],
    });
  } finally {
    await client.close();
  }
}

function mcpResultToModelOutput({
  output,
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}): ToolResultOutput {
  const result = output as {
    content?: Array<Record<string, unknown>>;
  };
  if (!result?.content || !Array.isArray(result.content)) {
    return {
      type: 'json',
      value: output as Parameters<typeof JSON.stringify>[0],
    } as ToolResultOutput;
  }
  return {
    type: 'content',
    value: result.content.map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return { type: 'text' as const, text: part.text };
      }
      if (
        part.type === 'image' &&
        typeof part.data === 'string' &&
        typeof part.mimeType === 'string'
      ) {
        return {
          type: 'image-data' as const,
          data: part.data,
          mediaType: part.mimeType,
        };
      }
      return { type: 'text' as const, text: JSON.stringify(part) };
    }),
  } as ToolResultOutput;
}

export async function getMCPTools(
  config: MCPRemoteServersConfig | undefined,
  baseName = 'MCP',
  context?: {
    sessionId?: string;
    runId?: string;
    agentName?: string;
  },
  appConfig?: import('@/types/config').AppConfig,
): Promise<ToolSet> {
  const [builtinToolDescriptors, remoteToolDescriptors] = await Promise.all([
    listBuiltinMCPToolDescriptors(baseName),
    listMCPToolDescriptors(config ?? {}, baseName),
  ]);
  const toolDescriptors = [...builtinToolDescriptors, ...remoteToolDescriptors];
  const allTools: ToolSet = {};

  const secCtx = appConfig
    ? {
        sessionId: context?.sessionId ?? '',
        runId: context?.runId ?? context?.sessionId ?? '',
        agentName: context?.agentName ?? '',
        appConfig,
      }
    : undefined;

  for (const descriptor of toolDescriptors) {
    allTools[descriptor.key] = withToolExecutionLogger(
      dynamicTool({
        ...(descriptor.title ? { title: descriptor.title } : {}),
        description:
          descriptor.description ??
          `Execute MCP tool "${descriptor.toolName}" from server "${descriptor.serverName}"`,
        inputSchema: createMCPInputSchema(descriptor.inputSchema),
        toModelOutput: mcpResultToModelOutput,
        execute: async (input) => {
          const args =
            typeof input === 'object' && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {};

          return descriptor.builtin
            ? await executeBuiltinMCPTool({
                serverName: descriptor.serverName,
                toolName: descriptor.toolName,
                args,
                context,
              })
            : await executeMCPTool({
                config: config ?? {},
                serverName: descriptor.serverName,
                toolName: descriptor.toolName,
                toolKey: descriptor.key,
                args,
              });
        },
      }),
      {
        provider: 'mcp',
        toolId: descriptor.key,
        toolName: descriptor.toolName,
        serverName: descriptor.serverName,
        sessionId: context?.sessionId,
        runId: context?.runId,
        agentName: context?.agentName,
      },
      secCtx,
    );
  }

  return allTools;
}
