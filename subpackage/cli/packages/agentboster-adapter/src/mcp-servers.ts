/**
 * Fetch the MCP servers registered on the Web backend.
 *
 * Mirrors GET /api/cli/mcp-servers. The Web "MCP Hub" is the single source
 * of truth for which MCP servers exist; this call lets the CLI surface that
 * same catalog (and, for the directly-connectable subset — `none` and
 * `static-headers` auth — attach as an MCP client).
 *
 * Only connection metadata is returned. Static-header SECRETS and OAuth
 * tokens are never sent down by the Web backend; the CLI must prompt for
 * any secret locally or proxy through the Web `/api/config/mcp/*` routes.
 */

export interface RemoteMcpServer {
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  /** Env var KEY NAMES only — values are not echoed back by the backend. */
  envKeys: string[];
  authMode: 'none' | 'static-headers' | 'oauth' | string;
  description?: string;
}

export interface McpServersResponse {
  ok: boolean;
  servers: RemoteMcpServer[];
}

/**
 * Fetch the Web-registered MCP server catalog. Returns an empty list on
 * auth failure or network error — callers should treat empty as "no remote
 * servers configured" rather than crashing.
 */
export async function fetchRemoteMcpServers(
  baseUrl: string,
  token: string,
): Promise<RemoteMcpServer[]> {
  const root = baseUrl.replace(/\/$/, '');
  try {
    const response = await fetch(`${root}/api/cli/mcp-servers`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `clawless-auth=${token}`,
      },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as McpServersResponse;
    return body.servers ?? [];
  } catch {
    return [];
  }
}
