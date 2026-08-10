import { requireAuthAccess } from '@/lib/auth/access';
import { assertCanReadSession } from '@/lib/chat/session-access';
import { assertSessionWritable } from '@/lib/chat/access';
import { getSessionByWorkflowRunId } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { resumeWithMessage } from '@/lib/workflow/agent/dispatch';
import { chatHookPayloadSchema } from '@/types/workflow';
import { cookies } from 'next/headers';
import { z } from 'zod';

const logger = createLogger('api.ai.run.message');

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const session = await getSessionByWorkflowRunId(runId);
  if (!session) {
    return Response.json(
      { ok: false, error: 'Run not found.' },
      { status: 404 },
    );
  }
  await assertCanReadSession(access, session);

  try {
    assertSessionWritable(
      { type: 'web', userId: access.session.userId },
      {
        id: session.id,
        userId: session.userId,
        channel: session.channel,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Forbidden';
    return Response.json(
      {
        ok: false,
        error: 'cross_channel_readonly',
        message,
        sessionChannel: session.channel,
        currentChannel: 'web',
      },
      { status: 403 },
    );
  }

  let payload: z.infer<typeof chatHookPayloadSchema>;
  try {
    payload = chatHookPayloadSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { ok: false, error: 'Invalid payload', details: error.issues },
        { status: 400 },
      );
    }
    return Response.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  await resumeWithMessage(runId, payload);

  logger.info('message:queued', {
    runId,
    type: payload.type,
  });

  return Response.json({ ok: true });
}
