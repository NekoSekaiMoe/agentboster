import { createLogger } from '@/lib/utils/logger';
import { resumeWithMessage } from '@/lib/workflow/agent/dispatch';
import { chatHookPayloadSchema } from '@/types/workflow';
import { z } from 'zod';

const logger = createLogger('api.ai.run.message');

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

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
