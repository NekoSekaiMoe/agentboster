import { extractMemoriesFromSession } from '@/lib/memory/extract';
import { getSession } from '@/lib/core/db/chat';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.task-memory');

const requestSchema = z.object({
  status: z.string(),
  result: z.string(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  command: z.string().optional(),
  user_id: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: taskId } = await params;
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { session_id: sessionId, user_id: requestUserId } = parsed.data;

    // Resolve the user this task belongs to. Prefer the explicit field the
    // daemon sends; fall back to the session owner; finally 'agentd' so
    // extraction still has somewhere to write if neither is available.
    let userId = requestUserId?.trim() || '';
    if (!userId && sessionId) {
      const session = await getSession(sessionId);
      userId = session?.userId ?? '';
    }
    if (!userId) {
      userId = 'agentd';
    }

    if (!sessionId) {
      // Nothing to extract from — daemon would normally always send one,
      // but degrade gracefully.
      return Response.json({ success: true, extracted: false });
    }

    const config = await getConfig();
    const result = await extractMemoriesFromSession({
      sessionId,
      userId,
      config,
    });

    logger.info('memory extracted', {
      taskId,
      sessionId,
      userId,
      ...result,
    });

    return Response.json({
      success: true,
      extracted: result.extracted > 0,
      created: result.created,
      updated: result.updated,
      total: result.extracted,
    });
  } catch (error) {
    logger.error('memory extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
