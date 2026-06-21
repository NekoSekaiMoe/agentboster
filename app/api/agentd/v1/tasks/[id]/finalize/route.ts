export const dynamic = 'force-dynamic';

import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  requireTaskAccess,
} from '@/lib/core/db/agentd';
import { extractTaskMemory } from '@/lib/extra/task-memory';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks.finalize');

function taskStatus(value: unknown) {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : 'completed';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    const task = await requireTaskAccess({
      taskId: id,
      sessionId:
        typeof body.session_id === 'string' ? body.session_id : undefined,
    });
    const result = await extractTaskMemory({
      taskId: id,
      agentId: task.agentId,
      sessionId: task.sessionId,
      command: task.command,
      result: typeof body.result === 'string' ? body.result : '',
      status: taskStatus(body.status),
    });

    logger.info('task finalized', { taskId: id, mode: result.mode });
    return Response.json({ success: true, data: result });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
