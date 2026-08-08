export const dynamic = 'force-dynamic';

import {
  createTask,
  formatTaskForAgentd,
  getResourceErrorMessage,
  getResourceErrorStatus,
  listTasks,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const task = await createTask({
      agentId: body.agent_id ?? 'default',
      sessionId: body.session_id,
      command: body.command,
      sandboxType: body.sandbox_type,
      sandboxId: body.sandbox_id,
      env: body.env,
      timeout: body.timeout,
    });
    logger.info('task created', { taskId: task.id, agentId: task.agentId });
    return Response.json({ success: true, data: formatTaskForAgentd(task) });
  } catch (error) {
    logger.error('task creation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    const status = getResourceErrorStatus(error);
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status },
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id') ?? 'default';
    const limit = Number(searchParams.get('limit') ?? 50);
    const sessionId = searchParams.get('session_id') ?? undefined;
    if (!sessionId) {
      return Response.json(
        { success: false, error: 'session_id is required' },
        { status: 400 },
      );
    }
    const access = await resolveAgentdResourceAccess({ sessionId });
    const tasks = await listTasks(agentId, limit, {
      sessionId,
      userId: access.userId,
    });
    return Response.json({
      success: true,
      data: tasks.map((task) => formatTaskForAgentd(task)),
    });
  } catch (error) {
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { success: false, error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('list tasks failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Internal error' },
      { status: 500 },
    );
  }
}
