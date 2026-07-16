import { NextRequest } from 'next/server';
import { getSession } from '@/lib/core/db/chat';
import { readAuthSessionFromRequest } from '@/lib/auth/session';
import {
  registerCliListener,
  unregisterCliListener,
  drainKvEvents,
  markCliOnline,
} from '@/lib/cli/remote-control';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('cli-session-events');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cli/session-events/[sessionId]
 *
 * SSE endpoint for CLI remote control mode.
 * CLI connects here to receive tool requests and heartbeat events.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authSession = await readAuthSessionFromRequest(req);
  if (!authSession) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const session = await getSession(sessionId, { userId: authSession.userId });
  if (!session) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  logger.info('CLI connected to session-events', { sessionId });

  // Create SSE stream
  const encoder = new TextEncoder();
  let intervalId: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Register in-process listener
      registerCliListener(sessionId, {
        send,
        sessionId,
        connectedAt: Date.now(),
      });

      // Send initial heartbeat
      send('heartbeat', { timestamp: Date.now() });

      // Heartbeat interval (every 30s)
      intervalId = setInterval(() => {
        send('heartbeat', { timestamp: Date.now() });
      }, 30000);

      // Poll KV for queued events (Vercel serverless fallback)
      const pollInterval = setInterval(async () => {
        try {
          const events = await drainKvEvents(sessionId);
          for (const evt of events) {
            send(evt.event, evt.data);
          }
        } catch (error) {
          logger.warn('Failed to drain KV events', { sessionId, error });
        }
      }, 2000);

      // Cleanup on close
      req.signal.addEventListener('abort', () => {
        if (intervalId) clearInterval(intervalId);
        clearInterval(pollInterval);
        unregisterCliListener(sessionId);
        logger.info('CLI disconnected from session-events', { sessionId });
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * POST /api/cli/session-events/[sessionId]/register
 *
 * Register CLI as online with capabilities and available tools.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authSession = await readAuthSessionFromRequest(req);
  if (!authSession) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const session = await getSession(sessionId, { userId: authSession.userId });
  if (!session) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const body = await req.json();
  const { capabilities, tools, cwd } = body;

  await markCliOnline(sessionId, {
    tools: tools || [],
    capabilities: capabilities || {
      hasDisplay: false,
      platform: 'unknown',
      isAdmin: false,
      scaleFactor: 1,
    },
    connectedAt: Date.now(),
    cwd: cwd || undefined,
  });

  logger.info('CLI registered as online', {
    sessionId,
    tools,
    capabilities,
    cwd,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
