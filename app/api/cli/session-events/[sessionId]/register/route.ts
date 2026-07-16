import { NextResponse } from 'next/server';
import { withCliAuth } from '@/lib/cli/auth';
import {
  markCliOnline,
  getImBinding,
  handleCliSessionSwitch,
} from '@/lib/cli/remote-control';
import { listUserSessions } from '@/lib/core/db/chat';

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
  });

  return NextResponse.json({ success: true });
});
