import { deliverSessionHeartbeat } from '@/lib/workflow/scheduled/heartbeat-dispatch';
import { isValidBotSecret } from '@/lib/bot/webhook';
import { createLogger } from '@/lib/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const logger = createLogger('api.bot.heartbeat');

const requestSchema = z.object({
  sessionId: z.string().min(1),
});

// Dispatching may start a chat workflow run (heartbeat wake-up); give it
// the same ceiling as the schedule trigger.
export const maxDuration = 300;

/**
 * POST /api/bot/{authSecret}/heartbeat
 *
 * Internal trigger endpoint for the session heartbeat wake loop
 * (sessionHeartbeatWorkflow). Auth is the shared bot secret embedded in
 * the path — same convention as /api/bot/{authSecret}/schedule.
 * deliverSessionHeartbeat CAS-claims the due slot, so concurrent or stale
 * wakes are harmless duplicates.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ authSecret: string }> },
) {
  const { authSecret } = await params;

  if (!isValidBotSecret(authSecret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    logger.warn('invalid_body', { error });
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400 },
    );
  }

  try {
    const result = await deliverSessionHeartbeat({ sessionId: body.sessionId });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('deliver_failed', {
      sessionId: body.sessionId,
      error: message,
    });
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
