import {
  getTaskSummary,
  upsertTaskSummary,
  writeMemories,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks.finalize');

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

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
  const result = typeof body.result === 'string' ? body.result : '';
  const agentId = typeof body.agent_id === 'string' ? body.agent_id : 'default';
  const sessionId =
    typeof body.session_id === 'string' ? body.session_id : undefined;
  const status = taskStatus(body.status);
  const summary = await getTaskSummary(id);

  if (summary) {
    const updated = await upsertTaskSummary({
      taskId: id,
      agentId: summary.agentId,
      sessionId: summary.sessionId ?? sessionId,
      status: status === 'completed' ? summary.status : 'paused',
      progress: `${status}: ${truncate(result, 200)}`,
      decisions: summary.decisions ?? undefined,
      pending: summary.pending ?? undefined,
      knownIssues: summary.knownIssues ?? undefined,
    });

    logger.info('long-running task summary finalized', { taskId: id, status });
    return Response.json({
      success: true,
      data: { mode: 'task_summary', summary: updated },
    });
  }

  if (result.trim().length > 0) {
    const memories = await writeMemories([
      {
        agentId,
        key: 'task.completed',
        value: `Task ${id} ${status}: ${truncate(result, 1000)}`,
        source: sessionId,
      },
    ]);

    logger.info('short task memory finalized', { taskId: id, status });
    return Response.json({
      success: true,
      data: { mode: 'memory', memories },
    });
  }

  logger.info('task finalized without summary or result', {
    taskId: id,
    status,
  });
  return Response.json({ success: true, data: { mode: 'none' } });
}
