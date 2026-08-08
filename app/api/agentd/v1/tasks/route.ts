export const dynamic = 'force-dynamic';

import {
  createTask,
  formatTaskForAgentd,
  getResourceErrorMessage,
  getResourceErrorStatus,
  listTasks,
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
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id') ?? 'default';
  const limit = Number(searchParams.get('limit') ?? 50);
  const sessionId = searchParams.get('session_id') ?? undefined;
  const tasks = await listTasks(agentId, limit, sessionId ? { sessionId } : undefined);
  return Response.json({
    success: true,
    data: tasks.map((task) => formatTaskForAgentd(task)),
  });
}
