import { deliverScheduledTask } from '@/lib/workflow/scheduled/dispatch';
import { isValidBotSecret } from '@/lib/bot/webhook';
import { createLogger } from '@/lib/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const logger = createLogger('api.bot.schedule');

const requestSchema = z.object({
  taskId: z.string().min(1),
  scheduledFor: z.string().optional(),
});

// Triggering a scheduled task may spawn a full chat workflow run, which
// can take much longer than the default 10s function maxDuration. Raise
// the ceiling so Vercel does not abort the dispatch mid-flight.
export const maxDuration = 300;

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
    const result = await deliverScheduledTask({
      taskId: body.taskId,
      scheduledFor: body.scheduledFor,
    });

    logger.info('delivered', {
      taskId: body.taskId,
      status: result.status,
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    logger.error('deliver_failed', { taskId: body.taskId, error });
    return NextResponse.json(
      { error: 'Failed to deliver scheduled task.' },
      { status: 500 },
    );
  }
}
