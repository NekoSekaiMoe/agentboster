import { type JSONRPCMessage, type MCPTransport } from '@ai-sdk/mcp';

import { browserTools, executeBrowserTool } from '../tools/browser';
import { builtinContext7Tools, executeBuiltinContext7Tool } from './context7';
import {
  builtinFirecrawlTools,
  executeBuiltinFirecrawlTool,
} from './firecrawl';
import { builtinGithubTools, executeBuiltinGithubTool } from './github';
import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';
import { builtinWebTools, executeBuiltinWebTool } from './web';

type BuiltinServerName =
  | 'web'
  | 'browser'
  | 'firecrawl'
  | 'github'
  | 'context7';

type BuiltinServerDefinition = {
  serverInfo: { name: string; version: string; title?: string };
  instructions: string;
  tools: BuiltinMcpToolDefinition[];
  execute: (
    toolName: string,
    input: Record<string, unknown>,
    context?: BuiltinMcpServerContext,
  ) => Promise<BuiltinMcpToolResult>;
};

type BuiltinServerExport = {
  transport: MCPTransport;
  title?: string;
  instructions: string;
};

type BuiltinServerExportOptions = BuiltinMcpServerContext;

type MCPToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

const LATEST_PROTOCOL_VERSION = '2025-11-25';

const builtinServers: Record<BuiltinServerName, BuiltinServerDefinition> = {
  web: {
    serverInfo: {
      name: 'agentboster-builtin-web',
      version: '1.0.0',
      title: 'AgentBoster Builtin Web',
    },
    instructions: 'Public web search and HTTP page fetching.',
    tools: builtinWebTools,
    execute: executeBuiltinWebTool,
  },
  browser: {
    serverInfo: {
      name: 'agentboster-builtin-browser',
      version: '1.0.0',
      title: 'AgentBoster Builtin Browser',
    },
    instructions:
      'Headless browser automation (Playwright). The agent system prompt covers cross-side routing, profile persistence, and element-targeting strategies.',
    tools: browserTools,
    execute: executeBrowserTool,
  },
  firecrawl: {
    serverInfo: {
      name: 'agentboster-builtin-firecrawl',
      version: '1.0.0',
      title: 'AgentBoster Builtin Firecrawl',
    },
    instructions:
      'Use firecrawl_scrape for rendering-heavy pages and clean article extraction.',
    tools: builtinFirecrawlTools,
    execute: executeBuiltinFirecrawlTool,
  },
  github: {
    serverInfo: {
      name: 'agentboster-builtin-github',
      version: '1.0.0',
      title: 'AgentBoster Builtin GitHub',
    },
    instructions:
      'Use GitHub tools for repo inspection, issue workflows, and pull request operations.',
    tools: builtinGithubTools,
    execute: executeBuiltinGithubTool,
  },
  context7: {
    serverInfo: {
      name: 'agentboster-builtin-context7',
      version: '1.0.0',
      title: 'AgentBoster Builtin Context7',
    },
    instructions:
      'Use context7_search_docs for project documentation and codebase guidance.',
    tools: builtinContext7Tools,
    execute: executeBuiltinContext7Tool,
  },
};

function toMcpTool(tool: BuiltinMcpToolDefinition): MCPToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function buildResult(result: BuiltinMcpToolResult) {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

class InMemoryBuiltinMcpTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protocolVersion?: string;

  constructor(
    private readonly server: BuiltinServerDefinition,
    private readonly context: BuiltinMcpServerContext = {},
  ) {}

  async start(): Promise<void> {
    return;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message) || !('id' in message)) {
      return;
    }

    try {
      if (message.method === 'initialize') {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            serverInfo: this.server.serverInfo,
            capabilities: {
              tools: {},
            },
            instructions: this.server.instructions,
          },
        });
        return;
      }

      if (message.method === 'tools/list') {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: this.server.tools.map(toMcpTool),
          },
        });
        return;
      }

      if (message.method === 'tools/call') {
        const toolName = message.params?.name;
        if (typeof toolName !== 'string') {
          this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'Missing tool name' },
          });
          return;
        }

        const result = await this.server.execute(
          toolName,
          (message.params?.arguments ?? {}) as Record<string, unknown>,
          this.context,
        );

        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: buildResult(result),
        });
        return;
      }

      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${message.method}` },
      });
    } catch (error) {
      this.onerror?.(
        error instanceof Error ? error : new Error('Builtin MCP error'),
      );
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Builtin MCP error',
        },
      });
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

export function createBuiltinMcpTransport(
  serverName: BuiltinServerName,
  context?: BuiltinMcpServerContext,
) {
  return new InMemoryBuiltinMcpTransport(builtinServers[serverName], context);
}

export function getBuiltinMcpServers(options: BuiltinServerExportOptions = {}) {
  return Object.fromEntries(
    (
      Object.entries(builtinServers) as Array<
        [BuiltinServerName, BuiltinServerDefinition]
      >
    ).map(([serverName, server]) => [
      serverName,
      {
        transport: createBuiltinMcpTransport(serverName, options),
        title: server.serverInfo.title,
        instructions: server.instructions,
      },
    ]),
  ) as unknown as Record<BuiltinServerName, BuiltinServerExport>;
}

/**
 * P1.2: Direct-call helper for builtin MCP servers. Used by the daemon
 * MCP bridge route (app/api/agentd/v1/tools/mcp-exec) so agentd can
 * invoke builtin MCP tools without going through the AI SDK ToolSet
 * machinery (which is bound to Vercel Workflow 'use step').
 *
 * Returns the raw BuiltinMcpToolResult. Callers should JSON-stringify
 * it for return to the daemon.
 */
export async function executeBuiltinMcpTool(
  serverName: string,
  toolName: string,
  input: Record<string, unknown>,
  context?: BuiltinMcpServerContext,
): Promise<
  { ok: true; result: BuiltinMcpToolResult } | { ok: false; error: string }
> {
  const server = (
    builtinServers as Record<string, BuiltinServerDefinition | undefined>
  )[serverName];
  if (!server) {
    return {
      ok: false,
      error: `unknown builtin MCP server: ${serverName}`,
    };
  }
  const known = server.tools.some((t) => t.name === toolName);
  if (!known) {
    return {
      ok: false,
      error: `builtin server "${serverName}" has no tool "${toolName}"`,
    };
  }
  try {
    const result = await server.execute(toolName, input, context);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * P1.2: List the names of all builtin MCP servers. Used by the daemon
 * to validate mcp_servers allowlists in agent config.
 */
export function listBuiltinMcpServerNames(): string[] {
  return Object.keys(builtinServers);
}

export type { BuiltinServerName };
