import {
  formatTaskForAgentd,
  getTask,
  updateTaskStatus,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) {
    return Response.json(
      { success: false, error: 'Task not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: formatTaskForAgentd(task) });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const task = await updateTaskStatus(id, body.status, body.result);
  logger.info('task updated', { taskId: id, status: body.status });
  return Response.json({
    success: true,
    data: task ? formatTaskForAgentd(task) : null,
  });
}
