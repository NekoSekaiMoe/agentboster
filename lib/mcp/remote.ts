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
 * In-process single-flight map for OAuth refreshes. Keyed by vault key
 * (not server name — renamed servers share the bundle via vaultKey).
 *
 * The atomic vault upsert alone does NOT make concurrent refreshes
 * safe: two parallel calls would BOTH hit the provider's token endpoint
 * with the same refresh_token. RFC 6749 §6 allows providers to revoke
 * the entire credential family on a second use of an already-consumed
 * refresh_token — so the loser of the race would invalidate the winner's
 * fresh token too, bricking the connection until the operator reconnects.
 *
 * The single-flight dedupes refresh attempts within this process. For
 * multi-process deployments a full fix needs a distributed lock, but
 * the in-process guard already eliminates the common single-server race.
 */
const refreshInFlight = new Map<string, Promise<McpOAuthTokenBundle | null>>();

async function refreshBundleOnce(params: {
  vaultKey: string;
  serverName: string;
  refresh: () => Promise<McpOAuthTokenBundle | null>;
}): Promise<McpOAuthTokenBundle | null> {
  const existing = refreshInFlight.get(params.vaultKey);
  if (existing) return existing;
  const p = params.refresh().finally(() => {
    refreshInFlight.delete(params.vaultKey);
  });
  refreshInFlight.set(params.vaultKey, p);
  return p;
}

/**
 * Resolve the headers to send for a given server, applying OAuth bearer
 * token injection when the server is configured with mode 'oauth'.
 *
 * `allowRefresh: false` skips the refresh attempt entirely — used by
 * `testRemoteMcpServer` so a connectivity test surfaces the real 401
 * instead of silently rotating the token.
 *
 * Mutates the bundle in vault if a refresh happened. Concurrent refreshes
 * for the same vault key are deduped in-process (see `refreshBundleOnce`).
 */
async function resolveHeadersForServer(params: {
  serverName: string;
  serverConfig: MCPRemoteServerConfig;
  allowRefresh?: boolean;
}): Promise<Record<string, string>> {
  const { serverName, serverConfig } = params;
  const allowRefresh = params.allowRefresh ?? true;
  // Copy the base headers so we never mutate the caller's config object.
  const baseHeaders: Record<string, string> = {
    ...(serverConfig.headers ?? {}),
  };

  if (serverConfig.auth?.mode !== 'oauth' || !serverConfig.auth.oauth) {
    return baseHeaders;
  }

  const oauth = serverConfig.auth.oauth;
  let bundle = await readOAuthTokenBundle({
    serverName,
    vaultKey: oauth.vaultKey,
  });

  if (allowRefresh && !isTokenFresh(bundle) && bundle?.refreshToken) {
    const vaultKey = oauth.vaultKey ?? `mcp:oauth:${serverName}`;
    bundle = await refreshBundleOnce({
      vaultKey,
      serverName,
      refresh: async () => {
        try {
          logger.info('mcp_oauth_refreshing', { serverName });
          const refreshed = await refreshAccessToken({
            oauth,
            refreshToken: bundle?.refreshToken ?? '',
          });
          if (!refreshed) return bundle;
          const next: McpOAuthTokenBundle = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? bundle?.refreshToken,
            expiresAt: refreshed.expiresAt,
            tokenType: refreshed.tokenType ?? bundle?.tokenType,
            scope: refreshed.scope ?? bundle?.scope,
          };
          await storeOAuthTokenBundle({ serverName, bundle: next });
          return next;
        } catch (error) {
          logger.warn('mcp_oauth_refresh_failed', {
            serverName,
            error: error instanceof Error ? error.message : String(error),
          });
          return bundle;
        }
      },
    });
  }

  if (!bundle?.accessToken) {
    // No token at all — let the call fail with 401 so the operator sees
    // the server is reachable but unauthenticated, prompting a reconnect.
    return baseHeaders;
  }

  // Per RFC 6750 §2.1: "Authorization: Bearer <token>". Strip EVERY
  // existing authorization header from baseHeaders (case-insensitive)
  // before injecting ours, so we never send a stale PAT alongside the
  // OAuth bearer. (Headers can be either case from user config.)
  for (const key of Object.keys(baseHeaders)) {
    if (key.toLowerCase() === 'authorization') {
      delete baseHeaders[key];
    }
  }
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
  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;

  try {
    client = await createMCPClient({
      transport: {
        type: serverConfig.type,
        url: serverConfig.url,
        headers,
      },
    });

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
    // Guard: if createMCPClient threw before assignment there's nothing
    // to close. Wrap close() in its own try/catch so a cleanup failure
    // can't turn a successful tool result into a rejection.
    if (client) {
      try {
        await client.close();
      } catch (closeErr) {
        logger.warn('remote_mcp_close_failed', {
          serverName,
          toolName,
          error:
            closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      }
    }
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
 *
 * Hard 15s timeout: an unresponsive server must not hold the test
 * request open indefinitely (the operator is staring at a spinner).
 */
const REMOTE_MCP_TEST_TIMEOUT_MS = 15_000;

export async function testRemoteMcpServer(params: {
  serverName: string;
  serverConfig: MCPRemoteServerConfig;
}): Promise<RemoteMcpTestResult> {
  const { serverName, serverConfig } = params;
  const headers = await resolveHeadersForServer({
    serverName,
    serverConfig,
    allowRefresh: false,
  });

  const { createMCPClient } = await import('@ai-sdk/mcp');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REMOTE_MCP_TEST_TIMEOUT_MS,
  );
  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    client = await createMCPClient({
      transport: {
        type: serverConfig.type,
        url: serverConfig.url,
        headers,
      },
    });
    const definitions = await client.listTools({
      options: { signal: controller.signal },
    });
    return {
      ok: true,
      toolCount: definitions.tools.length,
      sampleToolNames: definitions.tools.slice(0, 5).map((t) => t.name),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info('mcp_test_failed', { serverName, error: message });
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
    if (client) {
      try {
        await client.close();
      } catch (closeErr) {
        logger.info('mcp_test_close_failed', {
          serverName,
          error:
            closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      }
    }
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
