import { withCliAuth } from '@/lib/cli/auth';
import { getConfig } from '@/lib/core/kv/config';

/**
 * GET /api/cli/mcp-servers
 *
 * Returns the MCP servers registered on the Web backend, so the CLI can
 * surface them (and, for the directly-connectable subset, attach them as
 * MCP clients). This is the "MCP Hub push to CLI" half of AionUi-style
 * unified MCP registration — configure once on Web, every attached CLI
 * sees the same catalog.
 *
 * Security: only the connection metadata is returned. Static-header
 * secrets and OAuth tokens are NOT sent down — OAuth tokens live in the
 * Vault (server-side only) and are used when the CLI proxies through the
 * Web `/api/config/mcp/*` endpoints, not by direct CLI-to-MCP-server
 * connections. The CLI can directly connect only to `none` and
 * `static-headers` servers, and even for `static-headers` the CLI must
 * prompt the user for the secret locally (it is not echoed back here).
 */
export const GET = withCliAuth(async (_request, { userId }) => {
  void userId; // AppConfig is global in single-tenant mode; userId reserved
  // for the future multi-tenant path.
  const config = await getConfig();
  const servers = config.mcp ?? {};
  const list = Object.entries(servers).map(([name, server]) => {
    const s = server as {
      type?: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      auth?: { mode?: string };
      description?: string;
    };
    return {
      name,
      type: s.type ?? 'remote',
      url: s.url,
      command: s.command,
      args: s.args,
      // Note: env may contain secrets; only expose key names, not values.
      envKeys: s.env ? Object.keys(s.env) : [],
      authMode: s.auth?.mode ?? 'none',
      description: s.description,
    };
  });
  return Response.json({ ok: true, servers: list });
});
