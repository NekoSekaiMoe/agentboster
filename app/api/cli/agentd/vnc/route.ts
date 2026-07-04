import { and, eq, gte } from 'drizzle-orm';

import { requireCliAuth } from '@/lib/cli/auth';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { getConfig } from '@/lib/core/kv/config';
import { resolveAgentdNodeUrlWithReason } from '@/lib/extra/agent/agentd-url';

export const dynamic = 'force-dynamic';

const NOVNC_VIEWER_PATH = '/vnc.html';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '600',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return Response.json(data, {
    ...init,
    headers,
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    await requireCliAuth(request);
  } catch (errorOrResponse) {
    if (errorOrResponse instanceof Response) {
      return withCors(errorOrResponse);
    }
    return json(
      { ok: false, error: 'Authentication failed.' },
      { status: 500 },
    );
  }

  try {
    return await getAgentdVncState(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, { status: 500 });
  }
}

async function getAgentdVncState(request: Request): Promise<Response> {
  const config = await getConfig();
  const agentdConfig = config.agentd;

  if (!agentdConfig?.enabled) {
    return json({
      ok: true,
      enabled: false,
      nodes: [],
      message: 'AgentD is disabled in Web config.',
    });
  }

  const url = new URL(request.url);
  const requestedNodeId = url.searchParams.get('nodeId')?.trim() || null;
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const where = requestedNodeId
    ? and(
        eq(agentdNodes.status, 'online'),
        eq(agentdNodes.nodeID, requestedNodeId),
        gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
      )
    : and(
        eq(agentdNodes.status, 'online'),
        gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
      );

  const rows = await db
    .select({
      nodeId: agentdNodes.nodeID,
      ip: agentdNodes.ip,
      port: agentdNodes.port,
      sandboxes: agentdNodes.sandboxes,
      version: agentdNodes.version,
      activeTasks: agentdNodes.activeTasks,
      activeSandboxes: agentdNodes.activeSandboxes,
      lastHeartbeat: agentdNodes.lastHeartbeat,
    })
    .from(agentdNodes)
    .where(where)
    .limit(requestedNodeId ? 1 : 50);

  const configuredNodes = agentdConfig.nodes ?? [];

  const nodes = rows.map((node) => {
    const resolution = resolveAgentdNodeUrlWithReason({
      configuredNodes,
      nodeId: node.nodeId,
      envUrl: process.env.AGENTD_URL,
      fallbackUrl: `http://${node.ip}:${node.port}`,
    });
    const configured = configuredNodes.find((entry) => entry.id === node.nodeId);

    return {
      nodeId: node.nodeId,
      label: configured?.name?.trim() || node.nodeId,
      version: node.version,
      sandboxes: node.sandboxes ?? [],
      activeTasks: node.activeTasks ?? 0,
      activeSandboxes: node.activeSandboxes ?? 0,
      lastHeartbeat: node.lastHeartbeat?.toISOString() ?? null,
      nodeUrlSource: resolution.reason,
      directUrlAvailable: false,
      viewerUrl: null,
      proxyUrl: null,
      proxyStatus: 'not-implemented' as const,
    };
  });

  return json({
    ok: true,
    enabled: true,
    nodes,
    viewerPath: NOVNC_VIEWER_PATH,
    proxyStatus: 'not-implemented',
    message:
      'Desktop can list online AgentD nodes. Live VNC viewing requires the Web/AgentD noVNC proxy, which is not implemented yet.',
  });
}
