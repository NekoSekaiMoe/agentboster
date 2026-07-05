import { and, eq, gte, inArray } from 'drizzle-orm';

import { requireCliAuth } from '@/lib/cli/auth';
import { db, schema } from '@/lib/core/db';
import { hasAdminRole, getUserById } from '@/lib/core/db/users';
import { getConfig } from '@/lib/core/kv/config';
import { requestAgentd } from '@/lib/extra/agent/agentd-http';
import { buildAgentdHttpConfig } from '@/lib/extra/agent/agentd-tools-client';
import { buildAgentdDesktopWsUrl } from '@/lib/extra/agent/agentd-vnc-link';
import { resolveAgentdNodeUrlWithReason } from '@/lib/extra/agent/agentd-url';

export const dynamic = 'force-dynamic';

const NOVNC_VIEWER_PATH = '/vnc.html';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '600',
};

type CliAccess = {
  isAdmin: boolean;
  userId: string;
};

type AgentdSessionStatus = {
  compactionCount: number | null;
  sandboxId: string | null;
  sandboxPath: string | null;
  sandboxType: string | null;
  sessionId: string;
};

type SessionRow = {
  id: string;
  sandboxId: string | null;
  status: string;
  title: string | null;
  updatedAt: Date;
  userId: string | null;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function parseAgentdSessionStatuses(payload: unknown): AgentdSessionStatus[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry) => {
      const data = asRecord(entry);
      const sessionId =
        typeof data.session_id === 'string' ? data.session_id.trim() : '';
      if (!sessionId) {
        return null;
      }
      return {
        compactionCount:
          typeof data.compaction_count === 'number'
            ? data.compaction_count
            : null,
        sandboxId:
          typeof data.sandbox_id === 'string' && data.sandbox_id.trim()
            ? data.sandbox_id.trim()
            : null,
        sandboxPath:
          typeof data.sandbox_path === 'string' && data.sandbox_path.trim()
            ? data.sandbox_path.trim()
            : null,
        sandboxType:
          typeof data.sandbox_type === 'string' && data.sandbox_type.trim()
            ? data.sandbox_type.trim()
            : null,
        sessionId,
      };
    })
    .filter((entry): entry is AgentdSessionStatus => Boolean(entry));
}

function sessionTitle(session: SessionRow): string {
  const title = session.title?.trim();
  if (title) {
    return title;
  }
  return `Session ${session.id.slice(0, 8)}`;
}

function sortByUpdatedAtDesc<T extends { updatedAt: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime;
  });
}

async function requireCliAccess(request: Request): Promise<CliAccess> {
  const session = await requireCliAuth(request);
  const user = await getUserById(session.userId);
  if (!user) {
    throw new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return {
    isAdmin: hasAdminRole(user.roles),
    userId: session.userId,
  };
}

async function loadAccessibleSessions(
  access: CliAccess,
  sessionIds: string[],
): Promise<Map<string, SessionRow>> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  const conditions = [
    inArray(schema.sessions.id, sessionIds),
    eq(schema.sessions.archived, false),
  ];
  if (!access.isAdmin) {
    conditions.push(eq(schema.sessions.userId, access.userId));
  }

  const rows = await db
    .select({
      id: schema.sessions.id,
      sandboxId: schema.sessions.sandboxId,
      status: schema.sessions.status,
      title: schema.sessions.title,
      updatedAt: schema.sessions.updatedAt,
      userId: schema.sessions.userId,
    })
    .from(schema.sessions)
    .where(and(...conditions));

  return new Map(rows.map((row) => [row.id, row]));
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function GET(request: Request): Promise<Response> {
  let access: CliAccess;
  try {
    access = await requireCliAccess(request);
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
    return await getAgentdVncState(request, access);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, { status: 500 });
  }
}

async function getAgentdVncState(
  request: Request,
  access: CliAccess,
): Promise<Response> {
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
        eq(schema.agentdNodes.status, 'online'),
        eq(schema.agentdNodes.nodeID, requestedNodeId),
        gte(schema.agentdNodes.lastHeartbeat, twoMinutesAgo),
      )
    : and(
        eq(schema.agentdNodes.status, 'online'),
        gte(schema.agentdNodes.lastHeartbeat, twoMinutesAgo),
      );

  const rows = await db
    .select({
      nodeId: schema.agentdNodes.nodeID,
      ip: schema.agentdNodes.ip,
      port: schema.agentdNodes.port,
      sandboxes: schema.agentdNodes.sandboxes,
      version: schema.agentdNodes.version,
      activeTasks: schema.agentdNodes.activeTasks,
      activeSandboxes: schema.agentdNodes.activeSandboxes,
      lastHeartbeat: schema.agentdNodes.lastHeartbeat,
    })
    .from(schema.agentdNodes)
    .where(where)
    .limit(requestedNodeId ? 1 : 50);

  const configuredNodes = agentdConfig.nodes ?? [];

  const nodeStates = await Promise.all(
    rows.map(async (node) => {
      const resolution = resolveAgentdNodeUrlWithReason({
        configuredNodes,
        nodeId: node.nodeId,
        envUrl: process.env.AGENTD_URL,
        fallbackUrl: `http://${node.ip}:${node.port}`,
      });
      const configured = configuredNodes.find((entry) => entry.id === node.nodeId);

      let proxyStatus: 'ready' | 'error' | 'no-session' = 'no-session';
      let proxyMessage = '';
      let runtimeSessions: AgentdSessionStatus[] = [];

      try {
        const response = await requestAgentd(
          await buildAgentdHttpConfig(resolution.url),
          'GET',
          '/api/v1/sessions/status',
        );
        if (!response.ok) {
          throw new Error(
            `AgentD session status failed: HTTP ${response.status}`,
          );
        }
        const body = JSON.parse(response.text) as {
          data?: unknown;
          error?: string;
          success?: boolean;
        };
        if (!body.success) {
          throw new Error(body.error || 'AgentD session status failed');
        }
        runtimeSessions = parseAgentdSessionStatuses(body.data);
      } catch (error) {
        proxyStatus = 'error';
        proxyMessage = error instanceof Error ? error.message : String(error);
      }

      return {
        activeSandboxes: node.activeSandboxes ?? 0,
        activeTasks: node.activeTasks ?? 0,
        configuredLabel: configured?.name?.trim() || '',
        lastHeartbeat: node.lastHeartbeat?.toISOString() ?? null,
        nodeId: node.nodeId,
        nodeUrl: resolution.url,
        nodeUrlSource: resolution.reason,
        proxyMessage,
        proxyStatus,
        runtimeSessions,
        sandboxes: node.sandboxes ?? [],
        version: node.version,
      };
    }),
  );

  const accessibleSessions = await loadAccessibleSessions(
    access,
    nodeStates.flatMap((node) =>
      node.runtimeSessions.map((session) => session.sessionId),
    ),
  );

  const nodes = nodeStates.map((node) => {
    const sessions = sortByUpdatedAtDesc(
      node.runtimeSessions
        .map((runtimeSession) => {
          const session = accessibleSessions.get(runtimeSession.sessionId);
          if (!session) {
            return null;
          }

          return {
            compactionCount: runtimeSession.compactionCount,
            sandboxId: runtimeSession.sandboxId ?? session.sandboxId ?? null,
            sandboxPath: runtimeSession.sandboxPath,
            sandboxType: runtimeSession.sandboxType,
            sessionId: session.id,
            status: session.status,
            title: sessionTitle(session),
            updatedAt: session.updatedAt.toISOString(),
            userId: session.userId,
            wsProxyUrl: buildAgentdDesktopWsUrl({
              baseUrl: node.nodeUrl,
              sessionId: session.id,
              secret: process.env.AGENTD_API_KEY ?? '',
            }),
          };
        })
        .filter((session): session is NonNullable<typeof session> =>
          Boolean(session),
        ),
    );

    const defaultSession = sessions[0] ?? null;
    const proxyStatus =
      sessions.length > 0 ? 'ready' : node.proxyStatus === 'error' ? 'error' : 'no-session';
    const message =
      node.proxyMessage ||
      (sessions.length === 0
        ? 'No accessible active sessions on this node.'
        : '');

    return {
      nodeId: node.nodeId,
      label: node.configuredLabel || node.nodeId,
      version: node.version,
      sandboxes: node.sandboxes,
      activeTasks: node.activeTasks,
      activeSandboxes: node.activeSandboxes,
      lastHeartbeat: node.lastHeartbeat,
      nodeUrlSource: node.nodeUrlSource,
      directUrlAvailable: sessions.length > 0,
      viewerUrl: null,
      proxyUrl: defaultSession?.wsProxyUrl ?? null,
      proxyStatus,
      wsProxyUrl: defaultSession?.wsProxyUrl ?? null,
      activeSessionId: defaultSession?.sessionId ?? null,
      sessionCount: sessions.length,
      sessions,
      message,
    };
  });

  const liveNodeCount = nodes.filter((node) => node.sessionCount > 0).length;

  return json({
    ok: true,
    enabled: true,
    nodes,
    viewerPath: NOVNC_VIEWER_PATH,
    proxyStatus: liveNodeCount > 0 ? 'ready' : 'no-session',
    message:
      liveNodeCount > 0
        ? 'Live AgentD desktop sessions are available.'
        : 'No accessible active AgentD desktop sessions are available right now.',
  });
}
