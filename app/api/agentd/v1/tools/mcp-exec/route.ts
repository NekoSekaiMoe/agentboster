/**
 * MCP bridge endpoint (daemon → web → MCP server).
 *
 * P1.2: agentd's mcp_call tool POSTs here to invoke an MCP tool by
 * server + tool name. The daemon can't reach MCP servers directly
 * (the @ai-sdk/mcp client lives in this web app), so this route
 * proxies the call.
 *
 * Currently supports builtin MCP servers (web, browser, firecrawl,
 * github, context7). Remote user-configured MCP servers will be
 * supported in a follow-up — they require 'use step' boundaries
 * (createMCPClient) which route handlers can't host directly.
 *
 * The daemon gates this route behind agentCfg.MCPEnabled — only
 * agents with mcp_enabled=true register the mcp_call tool. This route
 * still does its own server allowlist check as defense in depth.
 */

export const dynamic = 'force-dynamic';

import { executeBuiltinMcpTool } from '@/lib/mcp/builtin';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.tools.mcp-exec');

const requestSchema = z.object({
  server_name: z.string().min(1),
  tool_name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  agent_id: z.string().default(''),
  session_id: z.string().default(''),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: 'Invalid mcp-exec request',
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { server_name, tool_name, args, agent_id, session_id } = parsed.data;

  // Defense-in-depth: verify the agent is allowed to use this MCP server.
  // The daemon should have already gated this, but a misconfigured or
  // hostile daemon shouldn't be able to bypass.
  try {
    const config = await getConfig();
    const agentCfg = config.agents?.[agent_id];
    if (!agentCfg?.mcp_enabled) {
      logger.warn('mcp-exec denied: agent does not have MCP enabled', {
        agent_id,
        server_name,
      });
      return Response.json(
        {
          success: false,
          error: 'MCP not enabled for this agent',
        },
        { status: 403 },
      );
    }
    if (
      agentCfg.mcp_servers &&
      agentCfg.mcp_servers.length > 0 &&
      !agentCfg.mcp_servers.includes(server_name)
    ) {
      logger.warn('mcp-exec denied: server not in allowlist', {
        agent_id,
        server_name,
        allowed: agentCfg.mcp_servers,
      });
      return Response.json(
        {
          success: false,
          error: `MCP server "${server_name}" not in allowlist`,
        },
        { status: 403 },
      );
    }
  } catch (err) {
    logger.error('mcp-exec config check failed', {
      agent_id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail open — daemon already gated. Don't block on a config fetch bug.
  }

  // Invoke the builtin server directly (no 'use step' required).
  const result = await executeBuiltinMcpTool(
    server_name,
    tool_name,
    args,
    session_id ? { sessionId: session_id, agentName: agent_id } : undefined,
  );

  if (!result.ok) {
    logger.warn('mcp-exec failed', {
      server_name,
      tool_name,
      error: result.error,
    });
    return Response.json({
      success: false,
      error: result.error,
    });
  }

  logger.info('mcp-exec ok', {
    server_name,
    tool_name,
    agent_id,
  });

  // Flatten the BuiltinMcpToolResult into a JSON string for the daemon's
  // ToolResult.Data field (the agent sees a single string).
  return Response.json({
    success: true,
    data: JSON.stringify(result.result),
  });
}
