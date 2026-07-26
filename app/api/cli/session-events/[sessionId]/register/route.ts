import { NextResponse } from 'next/server';
import { withCliAuth } from '@/lib/cli/auth';
import {
  markCliOnline,
  getImBinding,
  handleCliSessionSwitch,
} from '@/lib/cli/remote-control';
import { getSession, listUserSessions } from '@/lib/core/db/chat';

function getSessionIdFromUrl(request: Request): string | null {
  const match = request.url.match(
    /\/api\/cli\/session-events\/([^/]+)\/register/,
  );
  return match?.[1] ?? null;
}

export const POST = withCliAuth(async (request, { userId }) => {
  const sessionId = getSessionIdFromUrl(request);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing session id.' },
      { status: 400 },
    );
  }

  const session = await getSession(sessionId, { userId });
  if (!session) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }

  const body = await request.json();

  const userSessions = await listUserSessions({ userId, limit: 50 });
  for (const s of userSessions) {
    if (s.id !== sessionId) {
      const binding = await getImBinding(s.id);
      if (binding) {
        await handleCliSessionSwitch(s.id, sessionId);
        break;
      }
    }
  }

  await markCliOnline(sessionId, {
    tools: body.tools ?? [],
    capabilities: body.capabilities ?? {
      hasDisplay: false,
      platform: 'unknown',
      isAdmin: false,
      scaleFactor: 1,
    },
    connectedAt: Date.now(),
    cwd: body.cwd,
    // Surface desktop-reported MCP servers into the KV so the workflow
    // tool registry can register them (subject to admin allowlist).
    // Coerce the shape defensively — desktops are remote clients and a
    // malformed payload must never crash the registration.
    mcpServers: sanitizeMcpServers(body.mcpServers),
  });

  return NextResponse.json({ success: true });
});

/**
 * Coerce an untrusted body.mcpServers into the CliRemoteMcpServer shape.
 * Drops any entry without a name, with a non-stdio transport, or with a
 * non-array command. We deliberately DON'T filter by allowlist here — that
 * happens at tool-registration time so admins can change the allowlist
 * without re-registering.
 */
function sanitizeMcpServers(raw: unknown):
  | {
      name: string;
      command: string[];
      env?: Record<string, string>;
      transport: 'stdio';
    }[]
  | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: {
    name: string;
    command: string[];
    env?: Record<string, string>;
    transport: 'stdio';
  }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name.trim()) continue;
    if (!Array.isArray(e.command) || e.command.length === 0) continue;
    if (e.transport !== 'stdio') continue;
    const command = e.command.filter((c): c is string => typeof c === 'string');
    if (command.length === 0) continue;
    let env: Record<string, string> | undefined;
    if (e.env && typeof e.env === 'object') {
      const src = e.env as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'string') cleaned[k] = v;
      }
      if (Object.keys(cleaned).length > 0) env = cleaned;
    }
    out.push({ name: e.name.trim(), command, env, transport: 'stdio' });
  }
  return out.length > 0 ? out : undefined;
}
