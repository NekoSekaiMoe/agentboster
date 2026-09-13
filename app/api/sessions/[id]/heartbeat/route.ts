import {
  assertCanAccessOwnedResource,
  AuthError,
  requireAuthAccess,
} from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import {
  clampHeartbeatIntervalMinutes,
  getSessionHeartbeat,
  HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
  upsertSessionHeartbeat,
} from '@/lib/core/db/heartbeat';
import { ADAPTER_NAMES } from '@/types/config/channels';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET/PUT /api/sessions/[id]/heartbeat
 *
 * Per-session heartbeat configuration (arkloop LLM Heartbeat port): a
 * scheduled agent wake-up that asks the model, via the forced
 * heartbeat_decision tool, whether it should proactively speak in this
 * session's IM thread. reply=true → the run composes and delivers a
 * message to the thread; reply=false → silent, nothing is sent.
 *
 * Heartbeats only make sense on IM sessions (web/CLI users are already
 * looking at the chat). PUT rejects other channels with 409.
 *
 * Auth: same per-session ownership check as the other
 * /api/sessions/[id]/* routes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const ownershipError = ownershipFailure(access, session);
  if (ownershipError) return ownershipError;

  const heartbeat = await getSessionHeartbeat(sessionId);
  return NextResponse.json({
    sessionId,
    channel: session.channel,
    supported: isImSessionChannel(session.channel),
    ...(heartbeat
      ? {
          enabled: heartbeat.enabled,
          intervalMinutes: heartbeat.intervalMinutes,
          nextRunAt: heartbeat.nextRunAt?.toISOString() ?? null,
          lastRunAt: heartbeat.lastRunAt?.toISOString() ?? null,
          lastDecisionAt: heartbeat.lastDecisionAt?.toISOString() ?? null,
          lastDecisionReply: heartbeat.lastDecisionReply,
          failureCount: heartbeat.failureCount,
        }
      : {
          enabled: false,
          intervalMinutes: HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
          nextRunAt: null,
          lastRunAt: null,
          lastDecisionAt: null,
          lastDecisionReply: null,
          failureCount: 0,
        }),
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const ownershipError = ownershipFailure(access, session);
  if (ownershipError) return ownershipError;

  if (!isImSessionChannel(session.channel)) {
    return NextResponse.json(
      {
        error:
          'Heartbeats are only available on IM sessions (proactive speak ' +
          'needs a thread to speak into).',
      },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  // `JSON.parse('null')` is valid JSON — the cast below does not change the
  // runtime value, so reading `input.enabled` off null would throw a
  // TypeError and surface as a 500. Reject non-object bodies first.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be an object.' },
      { status: 400 },
    );
  }
  const input = body as { enabled?: unknown; intervalMinutes?: unknown };
  if (typeof input.enabled !== 'boolean') {
    return NextResponse.json(
      { error: '`enabled` must be a boolean.' },
      { status: 400 },
    );
  }
  const intervalMinutes =
    input.intervalMinutes === undefined
      ? HEARTBEAT_DEFAULT_INTERVAL_MINUTES
      : clampHeartbeatIntervalMinutes(
          typeof input.intervalMinutes === 'number'
            ? input.intervalMinutes
            : Number.NaN,
        );

  const heartbeat = await upsertSessionHeartbeat({
    sessionId,
    enabled: input.enabled,
    intervalMinutes,
  });

  // Arm the wake loop on enable. Fire-and-forget: starting is best-effort
  // (a failed start leaves the row armed; the next PUT re-tries, and a
  // lazy sweeper can backstop later). Disabling needs no action — the
  // loop exits at its next read.
  if (heartbeat.enabled) {
    const { ensureHeartbeatWorkflow } = await import(
      '@/lib/workflow/scheduled/heartbeat-dispatch'
    );
    await ensureHeartbeatWorkflow(sessionId);
  }

  return NextResponse.json({
    sessionId,
    enabled: heartbeat.enabled,
    intervalMinutes: heartbeat.intervalMinutes,
    nextRunAt: heartbeat.nextRunAt?.toISOString() ?? null,
  });
}

function isImSessionChannel(channel: string): boolean {
  return (ADAPTER_NAMES as readonly string[]).includes(channel);
}

/**
 * Ownership gate: assertCanAccessOwnedResource throws AuthError('Forbidden',
 * 403), which Next would otherwise surface as an uncaught 500. Convert it
 * into the proper status response instead.
 */
function ownershipFailure(
  access: Awaited<ReturnType<typeof requireAuthAccess>>,
  session: { userId: string | null },
): NextResponse | null {
  try {
    assertCanAccessOwnedResource(access, session.userId);
    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
