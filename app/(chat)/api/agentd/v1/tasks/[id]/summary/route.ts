import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  getTaskSummary,
  requireTaskAccess,
  upsertTaskSummary,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.task-summary');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireTaskAccess({ taskId: id });
    const summary = await getTaskSummary(id);
    if (!summary) {
      return Response.json(
        { success: false, error: 'Task summary not found' },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: summary });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  try {
    const task = await requireTaskAccess({
      taskId: id,
      sessionId:
        typeof body.session_id === 'string' ? body.session_id : undefined,
    });
    const existing = await getTaskSummary(id);

    const summary = await upsertTaskSummary({
      taskId: id,
      agentId: task.agentId,
      sessionId: task.sessionId,
      status: body.status ?? existing?.status,
      progress: body.progress ?? existing?.progress,
      decisions: body.decisions ?? existing?.decisions,
      pending: body.pending ?? existing?.pending,
      knownIssues: body.known_issues ?? existing?.knownIssues,
    });

    logger.info('task summary updated', { taskId: id });
    return Response.json({ success: true, data: summary });
  } catch (error) {
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
