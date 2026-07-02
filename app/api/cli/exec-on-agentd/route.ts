/**
 * POST /api/cli/exec-on-agentd
 *
 * Proxy a `local_*` tool invocation from a CLI session to a specific
 * Agent Daemon node. This is the execution path that activates when
 * the user has run `/switch` in the CLI to redirect tool execution to
 * a remote node.
 *
 * Why this exists: the CLI is a thin client and never holds agentd
 * credentials (mTLS cert/key + AGENTD_API_KEY). When a session is
 * switched to a remote node, the CLI POSTs the tool call here, the
 * Web server resolves the node's reachable URL from AppConfig + the
 * agentdNodes row, attaches credentials, and forwards to the daemon.
 *
 * Request body:
 *   { nodeId, sessionId, toolName, toolInput }
 *
 * The toolName is the Web backend's local_* vocabulary
 * (local_read_file / local_write_file / local_exec / local_grep /
 * local_ask_question). agentd's /api/v1/tools/exec accepts those
 * verbatim — they are the same names the workflow uses when routing
 * a sandbox session to agentd.
 *
 * Security: the CLI already runs its L0/L1/L2 gate against the command
 * before POSTing here (its handleLocalToolRequest runs
 * evaluateLocalCommand regardless of local vs remote target). We
 * additionally re-run the L0 deny check server-side: it's cheap (pure
 * local regex, no LLM call) and protects against a compromised CLI or
 * stale client-side rule cache. L1 is not re-run — it's an LLM
 * round-trip and the CLI already paid it.
 */

import { withCliAuth } from '@/lib/cli/auth';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { eq } from 'drizzle-orm';
import { getConfig as getAppConfig } from '@/lib/core/kv/config';
import {
  buildAgentdHttpConfig,
  dispatchToolToAgentd,
} from '@/lib/extra/agent/agentd-tools-client';

interface ExecRequestBody {
  nodeId?: unknown;
  sessionId?: unknown;
  toolName?: unknown;
  toolInput?: unknown;
}

export const POST = withCliAuth(async (request, { userId }) => {
  const body = (await request
    .json()
    .catch(() => null)) as ExecRequestBody | null;
  if (!body) {
    return Response.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const nodeId =
    typeof body.nodeId === 'string' && body.nodeId.trim()
      ? body.nodeId.trim()
      : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const toolName = typeof body.toolName === 'string' ? body.toolName : '';
  const toolInput =
    body.toolInput && typeof body.toolInput === 'object'
      ? (body.toolInput as Record<string, unknown>)
      : {};

  if (!nodeId || !sessionId || !toolName) {
    return Response.json(
      { ok: false, error: 'nodeId, sessionId, and toolName are required' },
      { status: 400 },
    );
  }

  // Resolve the node row + its configured public URL (same precedence
  // as execToolOnAgentd: per-node configured url > AGENTD_URL > raw
  // ip:port). Reject before any agentd call if the node is unknown.
  const rows = await db
    .select({
      nodeId: agentdNodes.nodeID,
      ip: agentdNodes.ip,
      port: agentdNodes.port,
      status: agentdNodes.status,
    })
    .from(agentdNodes)
    .where(eq(agentdNodes.nodeID, nodeId))
    .limit(1);

  if (rows.length === 0) {
    return Response.json(
      { ok: false, error: `Node ${nodeId} not found` },
      { status: 404 },
    );
  }
  const row = rows[0];
  if (row.status !== 'online') {
    return Response.json(
      { ok: false, error: `Node ${nodeId} is ${row.status}` },
      { status: 503 },
    );
  }

  // L0 deny gate. The CLI already ran L0/L1/L2 against the same
  // command before POSTing here (its handleLocalToolRequest runs
  // evaluateLocalCommand regardless of local vs remote target), but
  // we re-run L0 server-side so a compromised CLI (or a stale rule
  // cache on the client) cannot bypass the server's current policy.
  // L0 is cheap (pure local regex, no LLM call); L1 is not re-run
  // because it's an LLM round-trip and the CLI already paid it.
  // local_ask_question has no file/shell side effects; skip the gate.
  if (toolName !== 'local_ask_question') {
    const l0Target =
      toolName === 'local_exec'
        ? String(toolInput.command ?? '')
        : String(toolInput.path ?? toolInput.command ?? '');
    if (l0Target) {
      const { evaluateL0 } = await import('@/lib/security/l0-engine');
      const l0 = await evaluateL0('global', l0Target);
      if (l0.blocked) {
        return Response.json(
          {
            ok: false,
            error: `Security blocked: L0 rule denied: ${l0.reason}`,
          },
          { status: 403 },
        );
      }
    }
  }

  const appConfig = await getAppConfig();
  const configuredNodes = appConfig.agentd?.nodes ?? [];
  const matchedUrl = configuredNodes.find((n) => n.id === nodeId)?.url;
  const nodeUrl =
    matchedUrl || process.env.AGENTD_URL || `http://${row.ip}:${row.port}`;

  void userId; // authenticated; not used for per-user node ACL yet

  try {
    const result = await dispatchToolToAgentd(buildAgentdHttpConfig(nodeUrl), {
      session_id: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
    });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
});
