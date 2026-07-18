/**
 * MCP bridge endpoint (daemon → web → MCP server).
 *
 * P1.2: agentd's mcp_call tool POSTs here to invoke an MCP tool by
 * server + tool name. The daemon can't reach MCP servers directly
 * (the @ai-sdk/mcp client lives in this web app), so this route
 * proxies the call.
 *
 * Supports two server sources:
 *   - Builtin (web, firecrawl, github, context7) via executeBuiltinMcpTool
 *   - Remote user-configured (http/sse) via executeRemoteMcpTool, sourced
 *     from AppConfig.mcp (see types/config/mcp.ts)
 *
 * Remote servers are addressed by their key in the `mcp` config map,
 * which the agent allowlist (`mcp_servers`) treats identically to
 * builtin names. A name that exists in both maps resolves to builtin
 * first — keep your remote server keys distinct from builtin names
 * (web/firecrawl/github/context7) to avoid surprises.
 *
 * The daemon gates this route behind agentCfg.MCPEnabled — only
 * agents with mcp_enabled=true register the mcp_call tool. This route
 * still does its own server allowlist check as defense in depth.
 */

export const dynamic = 'force-dynamic';

import { executeBuiltinMcpTool } from '@/lib/mcp/builtin';
import { executeRemoteMcpTool } from '@/lib/mcp/remote';
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

  // Load config once for both the allowlist check and the remote lookup.
  // The allowlist check below is defense-in-depth — the daemon should
  // have already gated, but a misconfigured or hostile daemon shouldn't
  // be able to bypass.
  const config = await getConfig();
  const agentCfg = config.agents?.[agent_id];

  try {
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
    // Fail closed: the allowlist is defense-in-depth, but a programming
    // bug in this check must NOT silently let the call through. Deny
    // explicitly so the failure is visible rather than dispatching a
    // remote tool that may not have been authorized.
    logger.error('mcp-exec allowlist check failed — denying', {
      agent_id,
      server_name,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      {
        success: false,
        error: 'MCP allowlist check failed',
      },
      { status: 500 },
    );
  }

  // Resolve the server source. Builtin names take precedence; anything
  // else is looked up in AppConfig.mcp as a remote server. We probe the
  // builtin call first because executeBuiltinMcpTool returns ok:false
  // (not throw) on unknown server/tool, which lets us fall through to
  // the remote path without try/catch noise.
  //
  // NOTE: we deliberately do NOT short-circuit on `isRemoteKey` here.
  // A user-configured remote whose key happens to collide with a builtin
  // name (e.g. `web`) used to bypass the builtin path entirely; that
  // silently replaced an approved builtin with an attacker-controllable
  // remote endpoint. We now always probe builtin first and only fall
  // through to remote when builtin reports "unknown server" — colliding
  // remote keys are still reachable under distinct names but the
  // builtin is never transparently shadowed.
  const remoteMcpConfig = config.mcp ?? {};

  // Builtin path
  {
    const result = await executeBuiltinMcpTool(
      server_name,
      tool_name,
      args,
      session_id ? { sessionId: session_id, agentName: agent_id } : undefined,
    );

    if (result.ok) {
      logger.info('mcp-exec ok (builtin)', {
        server_name,
        tool_name,
        agent_id,
      });
      return Response.json({
        success: true,
        data: JSON.stringify(result.result),
      });
    }

    // If the error is anything other than "unknown builtin server",
    // surface it — don't fall through to remote for tool-not-found or
    // execution failures. Only unknown-server falls through because the
    // caller may have added a new remote server since the daemon last
    // refreshed its server list.
    const isUnknownBuiltinServer = result.error.startsWith(
      'unknown builtin MCP server:',
    );
    if (!isUnknownBuiltinServer) {
      logger.warn('mcp-exec failed (builtin)', {
        server_name,
        tool_name,
        error: result.error,
      });
      return Response.json({ success: false, error: result.error });
    }
  }

  // Remote path
  const remoteResult = await executeRemoteMcpTool({
    config: remoteMcpConfig,
    serverName: server_name,
    toolName: tool_name,
    args,
  });

  if (!remoteResult.ok) {
    logger.warn('mcp-exec failed (remote)', {
      server_name,
      tool_name,
      error: remoteResult.error,
    });
    return Response.json({ success: false, error: remoteResult.error });
  }

  logger.info('mcp-exec ok (remote)', {
    server_name,
    tool_name,
    agent_id,
  });

  return Response.json({
    success: true,
    data: JSON.stringify(remoteResult.result),
  });
}
