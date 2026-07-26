/**
 * Collect local MCP services for the CLI session registrar.
 *
 * Wraps `discoverMcpServices` (which returns a rich shape for the desktop /
 * TUI surface) and trims it down to the minimal `RegistrarMcpServer` shape
 * the Web needs to decide what to register. Only stdio MCP servers that are
 * actually installed locally are forwarded — servers whose binary can't be
 * resolved are dropped because the Web would route a tool call back through
 * the CLI, and there'd be nothing to spawn.
 *
 * Used by remote-control and rpc modes when they start the registrar so the
 * Web's tool registry can surface allowlisted local MCP servers to the
 * agent (ref_liveagent.md §2.5: "desktop reports local MCP server list,
 * Web authenticates and dispatches").
 */

import {
  discoverMcpServices,
  type DiscoveredMcpService,
} from '../core/mcp-services.ts';
import type { RegistrarMcpServer } from '../core/cli-session-registrar.ts';

export async function collectLocalMcpServersForRegistrar(
  cwd: string,
): Promise<RegistrarMcpServer[]> {
  let discovered: DiscoveredMcpService[];
  try {
    discovered = await discoverMcpServices({ cwd });
  } catch {
    // MCP discovery must never block registration. Return an empty list so
    // the rest of the registrar flow (heartbeat, release) still runs.
    return [];
  }

  const out: RegistrarMcpServer[] = [];
  for (const svc of discovered) {
    // Only stdio servers are proxyable via the CLI SSE channel. LSP services
    // and remote MCP servers have different transports the registrar schema
    // doesn't describe.
    if (svc.protocol !== 'mcp') continue;
    // Skip servers the user doesn't actually have installed locally — the
    // Web would otherwise surface them and every tool call would fail.
    if (!svc.installed) continue;

    const command = [svc.command, ...svc.args].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (command.length === 0) continue;

    out.push({
      name: svc.name,
      command,
      // discoverMcpServices only exposes env KEYS (never values) to avoid
      // leaking secrets into logs, so we don't have real env values to send
      // here. The Web doesn't spawn the server itself — it tells the CLI to
      // spawn it, and the CLI re-reads the local config (which still has the
      // values). So forwarding env values is unnecessary AND unsafe; we omit.
      transport: 'stdio',
    });
  }
  return out;
}
