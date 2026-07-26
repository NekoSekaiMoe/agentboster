/**
 * Desktop MCP bridge — surfaces allowlisted MCP servers (reported by the
 * attached CLI / desktop) to the agent as a single generic call tool.
 *
 * Why a single generic `desktop_mcp_call` tool instead of one tool per MCP
 * server tool?
 *   - Listing each server's tools would require a synchronous
 *     `tools/list` round-trip through the CLI SSE channel at registration
 *     time, which is slow and racy (CLI may be offline at workflow start).
 *   - The generic-call shape keeps registration O(servers) instead of
 *     O(server × tools) and matches the agentd mcp_call tool semantics
 *     (admin trust model, server + tool routing).
 *   - The agent learns the available server names from the system prompt
 *     (the same place it learns builtin MCP tools) and explores a server's
 *     tools the same way it explores any MCP server: by calling list_tools
 *     first when it needs to.
 *
 * Lifecycle:
 *   1. CLI / desktop startup → collectLocalMcpServersForRegistrar → POST
 *      /api/cli/session-events/:sessionId/register with mcpServers.
 *   2. Workflow buildAgentTools → this factory reads KV cli-remote:<sid>
 *      and config.desktop_mcp_allowlist, keeps only allowlisted servers,
 *      and registers the generic call tool when at least one survives.
 *   3. Agent invokes desktop_mcp_call → writeLocalToolRequest + SSE push →
 *      CLI receives → CLI spawns / reuses the named MCP server and runs
 *      tools/call → result POSTed back to /api/ai/[runId]/tool-result.
 *
 * Same trust boundary as agentd's mcp_call: the admin allowlist is the
 * gate, the agent cannot reach servers the admin hasn't enabled.
 */

import { tool } from 'ai';
import { z } from 'zod';

import { writeLocalToolRequest } from '@/lib/workflow/agent/sender/writers';
import type { AppConfig } from '@/types/config';
import { defineBuildInTool } from '@/lib/workflow/agent/tools/define';

/** Allowed desktop MCP server (KV row joined with config allowlist). */
export interface AllowedDesktopServer {
  name: string;
  command: string[];
}

/**
 * Compute the intersection of "servers the desktop reported" and "servers
 * the admin allowlisted". Returned in stable name order so the prompt
 * section doesn't flicker across turns.
 *
 * Exported for unit testing the allowlist logic without spinning up a
 * workflow / KV.
 */
export function resolveAllowedDesktopServers(input: {
  reported?: { name: string; command: string[] }[];
  allowlist: AppConfig['desktop_mcp_allowlist'];
}): AllowedDesktopServer[] {
  const reported = input.reported ?? [];
  const allowlist = input.allowlist ?? {};
  const seen = new Set<string>();
  const out: AllowedDesktopServer[] = [];
  for (const server of reported) {
    const entry = allowlist[server.name];
    if (!entry || entry.enabled === false) continue;
    // Optional command pinning. The admin may pin an exact joined-command
    // string for this name; a desktop reporting a different command under
    // the same name is dropped. Empty commandHash = trust any command
    // (default — convenient but less safe). This is a string compare, NOT
    // a crypto hash: admins set the pin by copying the joined command they
    // see in the desktop report, so eyeball-able equality is the goal.
    if (entry.commandHash && entry.commandHash !== server.command.join(' ')) {
      continue;
    }
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    out.push({ name: server.name, command: server.command });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const desktopMcpCallSchema = z.object({
  server: z
    .string()
    .min(1)
    .describe(
      'Name of the desktop MCP server to call. Must be one of the servers listed in the Desktop MCP Tools section of the system prompt.',
    ),
  tool: z
    .string()
    .min(1)
    .describe(
      'Tool name on the target MCP server. Call "list_tools" first when you do not know which tools a server exposes.',
    ),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arguments object for the tool. Omit when the tool takes no arguments.',
    ),
});

export const desktopMcpRemoteTool = defineBuildInTool({
  id: 'desktop_mcp_remote',
  description:
    'Desktop MCP bridge — call tools on MCP servers attached to the user’s local machine (reported by the CLI / desktop). Available only when a CLI is online and the admin has allowlisted at least one of its MCP servers.',
  requiredConfig: [],
  optionalConfig: [],
  factory: (_config, context) => {
    const { source, sessionId, runId, appConfig } = context;
    if (!sessionId || !runId) return null;

    // Same source gating as computer-use-remote: only CLI sessions and
    // remote-controlled IM sessions have an attached local machine.
    const isRemoteIm = source?.type === 'im' && source.remoteIm === true;
    if (source?.type !== 'cli' && !isRemoteIm) return null;

    // Return a Promise<FactoryResult> — the factory signature allows
    // MaybePromise. We do the KV read here so registration reflects the
    // latest desktop report rather than a stale snapshot.
    return (async () => {
      let cliState: {
        online: boolean;
        mcpServers?: { name: string; command: string[] }[];
      } | null = null;
      try {
        const { getCliCapabilities } = await import('@/lib/cli/remote-control');
        cliState = await getCliCapabilities(sessionId);
      } catch {
        return null;
      }
      if (!cliState?.online) return null;

      const allowed = resolveAllowedDesktopServers({
        reported: cliState.mcpServers,
        allowlist: appConfig.desktop_mcp_allowlist,
      });
      if (allowed.length === 0) return null;

      const sid = sessionId;
      const allowedNames = allowed.map((s) => s.name);

      return {
        desktop_mcp_call: tool({
          description: `Call a tool on a desktop-attached MCP server. Allowed servers (configured by the admin): ${allowedNames.join(', ')}. Use "list_tools" as the tool name first to discover what a server exposes.`,
          inputSchema: desktopMcpCallSchema,
          execute: async (input, { toolCallId }) => {
            // Re-check the allowlist at call time: the desktop may have
            // reported a new server, or the admin may have toggled an entry
            // since registration. This is the security boundary — never
            // trust the registration-time check alone.
            if (!allowedNames.includes(input.server)) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Server "${input.server}" is not in the desktop MCP allowlist. Allowed: ${allowedNames.join(', ') || '(none)'}.`,
                  },
                ],
              };
            }

            await writeLocalToolRequest({
              toolCallId,
              toolName: 'desktop_mcp_call',
              toolInput: input,
            });
            try {
              const { pushToCliSession } = await import(
                '@/lib/cli/remote-control'
              );
              await pushToCliSession(sid, 'tool-request', {
                toolCallId,
                toolName: 'desktop_mcp_call',
                toolInput: input,
              });
            } catch {
              // SSE push is best-effort; the CLI also polls the
              // writeLocalToolRequest channel. Don't fail the tool call
              // just because the live push missed.
            }
            // The CLI POSTs the actual result back to
            // /api/ai/[runId]/tool-result, which resolves writeLocalToolRequest.
            return {};
          },
        }),
      };
    })();
  },
});

export default desktopMcpRemoteTool;
