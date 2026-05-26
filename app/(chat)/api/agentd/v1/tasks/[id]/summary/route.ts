import {
  getTaskSummary,
  upsertTaskSummary,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.task-summary');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const summary = await getTaskSummary(id);
  if (!summary) {
    return Response.json(
      { success: false, error: 'Task summary not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: summary });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const existing = await getTaskSummary(id);

  const summary = await upsertTaskSummary({
    taskId: id,
    agentId: body.agent_id ?? existing?.agentId ?? 'default',
    sessionId: body.session_id ?? existing?.sessionId,
    status: body.status ?? existing?.status,
    progress: body.progress ?? existing?.progress,
    decisions: body.decisions ?? existing?.decisions,
    pending: body.pending ?? existing?.pending,
    knownIssues: body.known_issues ?? existing?.knownIssues,
  });

  logger.info('task summary updated', { taskId: id });
  return Response.json({ success: true, data: summary });
}
