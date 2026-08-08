export const dynamic = 'force-dynamic';

import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import { getConfig } from '@/lib/core/kv/config';
import { getUserById } from '@/lib/core/db/users';
import { extractMemoriesFromSession } from '@/lib/memory/extract';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.task-memory');

const requestSchema = z.object({
  status: z.string(),
  result: z.string(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  command: z.string().optional(),
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

    // Identity is derived from the task/session scope, never from a body
    // field. The previous implementation trusted `body.user_id` first
    // ("Prefer the explicit field the daemon sends"), which let any
    // AGENTD_API_KEY holder pollute another user's memory bucket by
    // sending an arbitrary user_id. resolveAgentdResourceAccess reads the
    // owning user from the task row itself; the body is ignored.
    const access = await resolveAgentdResourceAccess({
      taskId,
      sessionId: parsed.data.session_id,
    });

    const sessionId = parsed.data.session_id;
    if (!sessionId) {
      // Nothing to extract from — daemon would normally always send one,
      // but degrade gracefully.
      return Response.json({ success: true, extracted: false });
    }

    const config = await getConfig();
    const user = await getUserById(access.userId);
    const result = await extractMemoriesFromSession({
      sessionId,
      userId: access.userId,
      config,
      user,
    });

    logger.info('memory extracted', {
      taskId,
      sessionId,
      userId: access.userId,
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
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('memory extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
