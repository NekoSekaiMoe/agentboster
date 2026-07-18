/**
 * Remote MCP server bridge (non-workflow context).
 *
 * `lib/workflow/agent/tools/mcp.ts::executeMCPTool` is the workflow-step
 * entry point (registered as 'use step', serialized into the workflow
 * bundle, executed by the DevKit sandbox). The daemon MCP bridge route
 * (app/api/agentd/v1/tools/mcp-exec) cannot host 'use step' functions,
 * so this module mirrors the same logic without the step boundary.
 *
 * Auth handling:
 *   - mode 'none'          → no auth header added
 *   - mode 'static-headers' → use config.headers as-is
 *   - mode 'oauth'         → load token bundle from vault; if expired and
 *                             a refresh_token is present, refresh + persist
 *                             before retrying. Bearer token overrides any
 *                             Authorization in config.headers.
 */

import { createLogger } from '@/lib/utils/logger';
import { getConfig } from '@/lib/core/kv/config';
import {
  isTokenFresh,
  readOAuthTokenBundle,
  storeOAuthTokenBundle,
  type McpOAuthTokenBundle,
} from './oauth-store';
import { refreshAccessToken } from './oauth-flow';
import type {
  MCPRemoteServerConfig,
  MCPRemoteServersConfig,
} from '@/types/config/mcp';

const logger = createLogger('mcp.remote');

export type RemoteMcpToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Resolve the headers to send for a given server, applying OAuth bearer
 * token injection when the server is configured with mode 'oauth'.
 *
 * Mutates the bundle in vault if a refresh happened (idempotent — if two
 * concurrent calls race the refresh, both will write the same new token
 * bundle from the server; vault upsert is atomic per key).
 */
async function resolveHeadersForServer(params: {
  serverName: string;
  serverConfig: MCPRemoteServerConfig;
}): Promise<Record<string, string>> {
  const { serverName, serverConfig } = params;
  const baseHeaders: Record<string, string> = {
    ...(serverConfig.headers ?? {}),
  };

  if (serverConfig.auth?.mode !== 'oauth' || !serverConfig.auth.oauth) {
    return baseHeaders;
  }

  const oauth = serverConfig.auth.oauth;
  let bundle = await readOAuthTokenBundle(serverName);

  if (!isTokenFresh(bundle) && bundle?.refreshToken) {
    try {
      logger.info('mcp_oauth_refreshing', { serverName });
      const refreshed = await refreshAccessToken({
        oauth,
        refreshToken: bundle.refreshToken,
      });
      if (refreshed) {
        const next: McpOAuthTokenBundle = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
          expiresAt: refreshed.expiresAt,
          tokenType: refreshed.tokenType ?? bundle.tokenType,
          scope: refreshed.scope ?? bundle.scope,
        };
        await storeOAuthTokenBundle({ serverName, bundle: next });
        bundle = next;
      }
    } catch (error) {
      logger.warn('mcp_oauth_refresh_failed', {
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!bundle?.accessToken) {
    // No token at all — let the call fail with 401 so the operator sees
    // the server is reachable but unauthenticated, prompting a reconnect.
    return baseHeaders;
  }

  // Per RFC 6750 §2.1: "Authorization: Bearer <token>". Override any
  // caller-supplied Authorization header to avoid sending a stale PAT
  // alongside the OAuth bearer.
  return {
    ...baseHeaders,
    authorization: `Bearer ${bundle.accessToken}`,
  };
}

/**
 * Execute a tool on a remote MCP server.
 *
 * Mirrors `executeMCPTool` in lib/workflow/agent/tools/mcp.ts minus the
 * 'use step' marker. Returns ok:false on transport / protocol errors
 * (callers — route handlers — translate to HTTP).
 */
export async function executeRemoteMcpTool(params: {
  config: MCPRemoteServersConfig;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<RemoteMcpToolResult> {
  const { config, serverName, toolName, args } = params;
  const serverConfig = config[serverName];
  if (!serverConfig) {
    return { ok: false, error: `MCP server "${serverName}" not found` };
  }

  const headers = await resolveHeadersForServer({ serverName, serverConfig });

  const { createMCPClient } = await import('@ai-sdk/mcp');
  const client = await createMCPClient({
    transport: {
      type: serverConfig.type,
      url: serverConfig.url,
      headers,
    },
  });

  try {
    const definitions = await client.listTools();
    const tools = client.toolsFromDefinitions(definitions);
    const tool = tools[toolName];

    if (!tool?.execute) {
      return {
        ok: false,
        error: `MCP tool "${toolName}" not found on server "${serverName}"`,
      };
    }

    const result = await tool.execute(args, {
      toolCallId: `${serverName}:${toolName}`,
      messages: [],
    });

    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('remote_mcp_exec_failed', {
      serverName,
      toolName,
      error: message,
    });
    return { ok: false, error: message };
  } finally {
    await client.close();
  }
}

/**
 * Test that a configured remote MCP server is reachable and that the
 * current credentials allow tools/list. Returns the count of tools
 * exposed, or an error message. Used by the config UI's "Test" button.
 *
 * Unlike executeRemoteMcpTool, this does NOT lazy-refresh OAuth tokens
 * — a failed test with an expired token surfaces the real error so the
 * operator knows to reconnect.
 */
export async function testRemoteMcpServer(params: {
  serverName: string;
  serverConfig: MCPRemoteServerConfig;
}): Promise<RemoteMcpTestResult> {
  const { serverName, serverConfig } = params;
  const headers = await resolveHeadersForServer({ serverName, serverConfig });

  const { createMCPClient } = await import('@ai-sdk/mcp');
  try {
    const client = await createMCPClient({
      transport: {
        type: serverConfig.type,
        url: serverConfig.url,
        headers,
      },
    });
    try {
      const definitions = await client.listTools();
      return {
        ok: true,
        toolCount: definitions.tools.length,
        sampleToolNames: definitions.tools.slice(0, 5).map((t) => t.name),
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info('mcp_test_failed', { serverName, error: message });
    return { ok: false, error: message };
  }
}

export type RemoteMcpTestResult =
  | { ok: true; toolCount: number; sampleToolNames: string[] }
  | { ok: false; error: string };

/**
 * Resolve whether a server name refers to a configured remote MCP server.
 * Used by the daemon bridge to decide between builtin and remote paths.
 */
export function isRemoteMcpServer(
  config: MCPRemoteServersConfig | undefined,
  serverName: string,
): boolean {
  return Boolean(config?.[serverName]);
}

/**
 * Convenience: load remote MCP config from KV. Returns {} if the section
 * is unset or the config can't be parsed.
 */
export async function loadRemoteMcpConfig(): Promise<MCPRemoteServersConfig> {
  const config = await getConfig();
  return config.mcp ?? {};
}

export type { MCPRemoteServerConfig };
